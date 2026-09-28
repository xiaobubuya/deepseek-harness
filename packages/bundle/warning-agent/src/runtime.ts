/**
 * Long-lived warning-agent Runtime ingress. The HTTP layer deliberately owns
 * only delivery admission and lifecycle bookkeeping; data access and policy
 * decisions remain in Agent Gateway.
 * @module @deepseek-ai/dsh-warning-agent/runtime
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent, type SessionId, type SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/cordis-plugin-loader'

const DELIVERY_PATH = '/internal/warning-agent/v1/deliveries'
const MAX_BODY_BYTES = 256 * 1024
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Runtime configuration resolved from the profile patch. */
export interface Config {
  host: string
  port: number
  sharedSecret: string
  gatewayCallbackUrl: string
  callbackTimeoutMs: number
  callbackRetryAttempts: number
  callbackRetryBackoffMs: number
  sessionDir: string
  maxConcurrentTasks: number
  taskTimeoutMs: number
  retentionMs: number
}

export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(8090),
  sharedSecret: z.string().default(''),
  gatewayCallbackUrl: z.string().default('http://agent-gateway:8080/internal/agent-gateway/v1/task-events'),
  callbackTimeoutMs: z.number().min(1).default(3000),
  callbackRetryAttempts: z.number().min(1).default(3),
  callbackRetryBackoffMs: z.number().min(0).default(250),
  sessionDir: z.string().default('/var/lib/warning-agent/sessions'),
  maxConcurrentTasks: z.number().min(1).default(4),
  taskTimeoutMs: z.number().min(1).default(10 * 60 * 1000),
  retentionMs: z.number().min(1).default(DEFAULT_RETENTION_MS),
})

/** Wire payload accepted from Agent Gateway. */
export interface WarningAgentDelivery {
  schemaVersion: string
  taskId: string
  incidentId: string
  taskType: string
  revision: number
  attempt: number
  priority: string
  deadlineAt: string
  allowedTools: string[]
  context: Record<string, unknown>
  actionGrant?: { popoTeam?: boolean }
}

/** Admission response returned for new and duplicate deliveries. */
export interface DeliveryAccepted {
  accepted: true
  duplicate: boolean
  taskId: string
  revision: number
  sessionId: string
  workflowId: string
  attempt: number
}

export interface RuntimeTask {
  delivery: WarningAgentDelivery
  sessionId: string
  workflowId: string
  status: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED'
  startedAt: number
  updatedAt: number
}

export interface TaskExecutionResult {
  status: 'SUCCEEDED' | 'FAILED'
  result: Record<string, unknown>
}

export interface TaskExecutor {
  execute(task: RuntimeTask, signal: AbortSignal): Promise<TaskExecutionResult>
}

/** Deterministic schema for hostile JSON at the HTTP boundary. */
const DeliverySchema = z.object({
  schemaVersion: z.string().required(),
  taskId: z.string().required(),
  incidentId: z.string().required(),
  taskType: z.string().required(),
  revision: z.number().min(0).required(),
  attempt: z.number().min(1).required(),
  priority: z.string().required(),
  deadlineAt: z.string().required(),
  allowedTools: z.array(z.string()).required(),
  context: z.dict(z.any()).required(),
  actionGrant: z.object({ popoTeam: z.boolean().default(false) }).default({ popoTeam: false }),
})

/** Runtime lifecycle and HTTP server. */
export class WarningAgentRuntime {
  private readonly tasks = new Map<string, RuntimeTask>()
  private readonly nonces = new Map<string, number>()
  private server: Server | undefined
  private accepting = true
  private cleanupTimer: NodeJS.Timeout | undefined
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly taskTimers = new Map<string, NodeJS.Timeout>()
  private readonly sessionExecutionTails = new Map<string, Promise<void>>()

  /**
   * @param config - validated Runtime settings.
   * @param now - injectable clock used by signature and replay tests.
   */
  constructor(
    private readonly config: Config,
    private readonly now: () => number = Date.now,
    private readonly executor?: TaskExecutor,
  ) {
    if (config.gatewayCallbackUrl !== '') {
      const url = new URL(config.gatewayCallbackUrl)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
        throw new Error('gatewayCallbackUrl must be an absolute HTTP(S) URL')
      }
    }
  }

  /** Number of currently admitted tasks, exposed for readiness and tests. */
  get activeTaskCount(): number {
    return [...this.tasks.values()].filter(task => task.status === 'RUNNING' || task.status === 'ACCEPTED').length
  }

  /** Start listening for internal Gateway traffic. */
  async listen(): Promise<void> {
    if (this.server !== undefined) return
    await this.restore()
    await mkdir(this.config.sessionDir, { recursive: true })
    this.accepting = true
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) this.writeJson(response, 500, { error: 'internal_error' })
        else response.destroy()
        // Do not leak request data or secrets into process output.
        void error
      })
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (server === undefined) return reject(new Error('runtime server was not created'))
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      const onListening = (): void => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.config.port, this.config.host)
    })
    this.cleanupTimer = setInterval(() => { void this.cleanup() }, Math.min(this.config.retentionMs, 60 * 60 * 1000))
    this.cleanupTimer.unref()
    for (const [key, task] of this.tasks) {
      if (this.isActive(task)) {
        this.armTimeout(key, task)
        this.startExecution(key, task)
      }
    }
  }

  /** Stop admission and close the listening socket. */
  async close(): Promise<void> {
    this.accepting = false
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
    for (const controller of this.abortControllers.values()) controller.abort()
    for (const timer of this.taskTimers.values()) clearTimeout(timer)
    this.abortControllers.clear()
    this.taskTimers.clear()
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /** Return a terminal state for the task, used by the future Agent driver. */
  complete(
    taskId: string,
    revision: number,
    attempt: number,
    status: Extract<RuntimeTask['status'], 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED'>,
  ): void {
    const key = `${taskId}:${String(revision)}:${String(attempt)}`
    const task = this.tasks.get(key)
    if (task === undefined || !this.isActive(task)) return
    this.finish(key, task, status, { status })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const path = new URL(request.url ?? '/', 'http://runtime').pathname
    if (method === 'GET' && path === '/health') return this.writeJson(response, 200, { status: 'ok' })
    if (method === 'GET' && path === '/ready') {
      return this.writeJson(response, this.server !== undefined && this.accepting ? 200 : 503, {
        status: this.server !== undefined && this.accepting ? 'ready' : 'draining',
      })
    }
    if (method === 'POST' && path.startsWith('/internal/warning-agent/v1/tasks/') && path.endsWith('/cancel')) {
      return this.handleCancel(path, request, response)
    }
    if (method !== 'POST' || path !== DELIVERY_PATH) return this.writeJson(response, 404, { error: 'not_found' })
    if (!this.accepting) return this.writeJson(response, 503, { error: 'runtime_draining' })
    let body: string
    try {
      body = await readBody(request)
    } catch {
      return this.writeJson(response, 413, { error: 'request_body_too_large' })
    }
    if (!this.verifySignature(method, path, body, request.headers)) return this.writeJson(response, 401, { error: 'invalid_signature' })
    let delivery: WarningAgentDelivery
    try {
      delivery = DeliverySchema(JSON.parse(body)) as WarningAgentDelivery
      if (delivery.schemaVersion !== 'v1') throw new Error('unsupported schema')
      if (!Number.isInteger(delivery.revision) || delivery.revision < 1) throw new Error('invalid revision')
      if (!Number.isInteger(delivery.attempt) || delivery.attempt < 1) throw new Error('invalid attempt')
    } catch {
      return this.writeJson(response, 400, { error: 'invalid_delivery' })
    }
    const key = this.key(delivery)
    const existing = this.tasks.get(key)
    if (existing !== undefined) {
      return this.writeJson(response, 202, {
        accepted: true,
        duplicate: true,
        taskId: delivery.taskId,
        revision: delivery.revision,
        attempt: delivery.attempt,
        sessionId: existing.sessionId,
        workflowId: existing.workflowId,
      } satisfies DeliveryAccepted)
    }
    if (this.activeTaskCount >= this.config.maxConcurrentTasks) {
      response.setHeader('retry-after', '5')
      return this.writeJson(response, 429, { error: 'runtime_busy', retryable: true })
    }
    const task: RuntimeTask = {
      delivery,
      sessionId: this.digest(`${delivery.taskId}:${delivery.revision}`),
      workflowId: this.digest(`${delivery.taskId}:${delivery.revision}:${delivery.attempt}`),
      status: 'ACCEPTED',
      startedAt: this.now(),
      updatedAt: this.now(),
    }
    this.tasks.set(key, task)
    task.status = 'RUNNING'
    this.abortControllers.set(key, new AbortController())
    await this.persist(task)
    void this.emitEvent(task, 'PROGRESS', { status: 'RUNNING' })
    this.armTimeout(key, task)
    this.startExecution(key, task)
    return this.writeJson(response, 202, {
      accepted: true,
      duplicate: false,
      taskId: delivery.taskId,
      revision: delivery.revision,
      attempt: delivery.attempt,
      sessionId: task.sessionId,
      workflowId: task.workflowId,
    } satisfies DeliveryAccepted)
  }

  private async handleCancel(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const taskId = path.slice('/internal/warning-agent/v1/tasks/'.length, -'/cancel'.length)
    const body = await readBody(request).catch(() => '')
    if (!this.verifySignature(request.method ?? 'POST', path, body, request.headers)) return this.writeJson(response, 401, { error: 'invalid_signature' })
    let payload: { revision?: number; attempt?: number }
    try { payload = JSON.parse(body) as { revision?: number; attempt?: number } } catch { return this.writeJson(response, 400, { error: 'invalid_cancel' }) }
    const key = `${taskId}:${String(payload.revision)}:${String(payload.attempt)}`
    const task = this.tasks.get(key)
    if (task === undefined) return this.writeJson(response, 404, { error: 'task_not_found' })
    const duplicate = task.status === 'CANCELLED'
    if (task.status === 'RUNNING' || task.status === 'ACCEPTED') {
      this.abortControllers.get(key)?.abort()
      this.finish(key, task, 'CANCELLED', { status: 'CANCELLED' })
    }
    return this.writeJson(response, 202, { taskId, status: task.status, duplicate })
  }

  private verifySignature(method: string, path: string, body: string, headers: IncomingMessage['headers']): boolean {
    if (this.config.sharedSecret === '') return false
    const timestamp = headers['x-warning-agent-timestamp']
    const nonce = headers['x-warning-agent-nonce']
    const signature = headers['x-warning-agent-signature']
    if (typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') return false
    const timestampMs = Number(timestamp)
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > SIGNATURE_WINDOW_MS) return false
    const expiresAt = this.nonces.get(nonce)
    if (expiresAt !== undefined && expiresAt > this.now()) return false
    for (const [knownNonce, expiry] of this.nonces) if (expiry <= this.now()) this.nonces.delete(knownNonce)
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`
    const expected = createHmac('sha256', this.config.sharedSecret).update(message).digest('hex')
    const actual = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature
    if (!/^[a-f0-9]{64}$/i.test(actual)) return false
    const valid = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
    if (valid) this.nonces.set(nonce, this.now() + SIGNATURE_WINDOW_MS)
    return valid
  }

  private writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
    const payload = JSON.stringify(value)
    response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }

  private key(delivery: Pick<WarningAgentDelivery, 'taskId' | 'revision' | 'attempt'>): string {
    return `${delivery.taskId}:${String(delivery.revision)}:${String(delivery.attempt)}`
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  private deadlineMs(delivery: WarningAgentDelivery): number {
    const deadline = Date.parse(delivery.deadlineAt)
    return Number.isFinite(deadline) ? Math.max(1, deadline - this.now()) : this.config.taskTimeoutMs
  }

  private armTimeout(key: string, task: RuntimeTask): void {
    const startedAt = task.startedAt ?? task.updatedAt
    const remainingTask = Math.max(1, this.config.taskTimeoutMs - (this.now() - startedAt))
    const remainingDeadline = this.deadlineMs(task.delivery)
    const oldTimer = this.taskTimers.get(key)
    if (oldTimer !== undefined) clearTimeout(oldTimer)
    const timer = setTimeout(() => {
      const current = this.tasks.get(key)
      if (current !== undefined && this.isActive(current)) {
        this.abortControllers.get(key)?.abort()
        this.finish(key, current, 'TIMEOUT', { status: 'TIMEOUT' })
      }
    }, Math.min(remainingTask, remainingDeadline))
    timer.unref()
    this.taskTimers.set(key, timer)
  }

  private isActive(task: RuntimeTask): boolean {
    return task.status === 'RUNNING' || task.status === 'ACCEPTED'
  }

  private finish(
    key: string,
    task: RuntimeTask,
    status: Extract<RuntimeTask['status'], 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED'>,
    result: Record<string, unknown>,
  ): void {
    const timer = this.taskTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.taskTimers.delete(key)
    this.abortControllers.delete(key)
    task.status = status
    task.updatedAt = this.now()
    void this.persist(task)
    void this.emitEvent(task, 'RESULT', result)
  }

  private startExecution(key: string, task: RuntimeTask): void {
    const executor = this.executor
    if (executor === undefined) return
    const previous = this.sessionExecutionTails.get(task.sessionId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      const current = this.tasks.get(key)
      if (current !== task || !this.isActive(task)) return
      const controller = this.abortControllers.get(key) ?? new AbortController()
      this.abortControllers.set(key, controller)
      try {
        const outcome = await executor.execute(task, controller.signal)
        const latest = this.tasks.get(key)
        if (latest === task && this.isActive(task)) this.finish(key, task, outcome.status, outcome.result)
      } catch (error: unknown) {
        const latest = this.tasks.get(key)
        if (latest === task && this.isActive(task)) this.finish(key, task, 'FAILED', {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
    const tail = run.finally(() => {
      if (this.sessionExecutionTails.get(task.sessionId) === tail) this.sessionExecutionTails.delete(task.sessionId)
    })
    this.sessionExecutionTails.set(task.sessionId, tail)
  }

  private async persist(task: RuntimeTask): Promise<void> {
    task.updatedAt = this.now()
    await mkdir(this.config.sessionDir, { recursive: true })
    await appendFile(join(this.config.sessionDir, this.taskFileName(task)), `${JSON.stringify({ at: this.now(), task })}\n`, 'utf8')
  }

  private taskFileName(task: RuntimeTask): string {
    return `${task.sessionId}.${this.digest(this.key(task.delivery)).slice(0, 16)}.jsonl`
  }

  private async restore(): Promise<void> {
    await mkdir(this.config.sessionDir, { recursive: true })
    for (const name of await readdir(this.config.sessionDir)) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const lines = (await readFile(join(this.config.sessionDir, name), 'utf8')).trim().split('\n').filter(Boolean)
        for (const line of lines) {
          const entry = JSON.parse(line) as { task?: RuntimeTask }
          if (entry.task !== undefined) {
            if (entry.task.startedAt === undefined) entry.task.startedAt = entry.task.updatedAt
            this.tasks.set(this.key(entry.task.delivery), entry.task)
          }
        }
      } catch { /* A corrupt session is ignored; Warning Center can retry it. */ }
    }
  }

  private async cleanup(): Promise<void> {
    const cutoff = this.now() - this.config.retentionMs
    for (const name of await readdir(this.config.sessionDir).catch(() => [] as string[])) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(this.config.sessionDir, name)
      try {
        const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean)
        const latestByKey = new Map<string, RuntimeTask>()
        for (const line of lines) {
          const task = (JSON.parse(line) as { task?: RuntimeTask }).task
          if (task !== undefined) latestByKey.set(this.key(task.delivery), task)
        }
        const tasks = [...latestByKey.values()]
        const terminal = tasks.length > 0 && tasks.every(task => ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(task.status))
        const info = await stat(file)
        const latestUpdatedAt = Math.max(...tasks.map(task => task.updatedAt), info.mtimeMs)
        if (terminal && latestUpdatedAt <= cutoff) {
          await unlink(file)
          for (const task of tasks) this.tasks.delete(this.key(task.delivery))
        }
      } catch { /* Cleanup is best effort and never blocks admission. */ }
    }
  }

  private async emitEvent(task: RuntimeTask, eventType: 'PROGRESS' | 'RESULT', result: Record<string, unknown>): Promise<void> {
    if (this.config.gatewayCallbackUrl === '') return
    const payload = JSON.stringify({
      schemaVersion: 'v1', eventId: this.digest(`${task.workflowId}:${eventType}:${task.status}`), eventType,
      taskId: task.delivery.taskId, revision: task.delivery.revision, attempt: task.delivery.attempt,
      sessionId: task.sessionId, workflowId: task.workflowId, status: task.status,
      occurredAt: new Date(this.now()).toISOString(), result,
    })
    const callbackUrl = new URL(this.config.gatewayCallbackUrl)
    const controller = this.abortControllers.get(this.key(task.delivery))
    for (let attempt = 0; attempt < this.config.callbackRetryAttempts; attempt++) {
      const timestamp = String(this.now())
      const nonce = this.digest(`${task.workflowId}:${eventType}:${timestamp}:${attempt}`)
      const message = `POST\n${callbackUrl.pathname}\n${timestamp}\n${nonce}\n${payload}`
      const signature = createHmac('sha256', this.config.sharedSecret).update(message).digest('hex')
      try {
        const signal = controller === undefined
          ? AbortSignal.timeout(this.config.callbackTimeoutMs)
          : AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.callbackTimeoutMs)])
        const response = await fetch(this.config.gatewayCallbackUrl, { method: 'POST', body: payload, signal, headers: {
          'content-type': 'application/json', 'x-warning-agent-timestamp': timestamp,
          'x-warning-agent-nonce': nonce, 'x-warning-agent-signature': `sha256=${signature}`,
        } })
        if (response.ok) return
        if (response.status !== 429 && response.status < 500) return
      } catch {
        if (controller?.signal.aborted) return
      }
      if (attempt + 1 < this.config.callbackRetryAttempts && this.config.callbackRetryBackoffMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.config.callbackRetryBackoffMs * (2 ** attempt)))
      }
    }
  }
}

class HarnessTaskExecutor implements TaskExecutor {
  constructor(private readonly ctx: Context) {}

  async execute(task: RuntimeTask, signal: AbortSignal): Promise<TaskExecutionResult> {
    await this.ctx.get('loader')?.await()
    signal.throwIfAborted()
    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    const sessions = this.ctx.get('sessions')
    const persistence = this.ctx.get('sessionPersistence')
    if (agents === undefined || defaultModel === undefined || sessions === undefined || persistence === undefined) {
      throw new Error('Harness Agent services are unavailable')
    }

    const sessionId = brandString<SessionId>(task.sessionId)
    const selection = defaultModel.currentSelection()
    const setup = (agentCtx: Context): void => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    let handle: AgentHandle | undefined
    let cancelAgent = (): void => {}
    try {
      const stored = await persistence.stat(sessionId, { signal })
      handle = stored === undefined
        ? await agents.create({
          sessionId,
          meta: { cwd: process.cwd() },
          agentOptions: { provider: selection.provider, model: selection.model },
          signal,
          setup,
        })
        : await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: selection.provider, model: selection.model },
          signal,
          setup,
        })
      const agent = handle.agent
      cancelAgent = (): void => agent.cancel({ kind: 'user' })
      signal.addEventListener('abort', cancelAgent, { once: true })
      await agent.whenIdle()
      signal.throwIfAborted()
      const firstSeq = agent.session.seq
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskPrompt(task.delivery) }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      signal.throwIfAborted()
      await sessions.flush(agent.session)
      const outcome = summarizeAgentRun(agent.session, firstSeq)
      return outcome.reason?.kind === 'completed'
        ? { status: 'SUCCEEDED', result: { status: 'SUCCEEDED', answer: outcome.text } }
        : {
          status: 'FAILED',
          result: {
            status: 'FAILED',
            answer: outcome.text,
            error: outcome.reason?.kind === 'error' ? outcome.reason.error.message : 'agent did not complete',
          },
        }
    } finally {
      signal.removeEventListener('abort', cancelAgent)
      await handle?.dispose()
    }
  }
}

function taskPrompt(delivery: WarningAgentDelivery): string {
  return [
    'Investigate this warning using only the supplied context and the explicitly registered tools.',
    'Do not invent evidence. State conclusions, evidence, unknowns, and recommended next actions.',
    `Task type: ${delivery.taskType}`,
    `Incident: ${delivery.incidentId}`,
    `Allowed tools: ${delivery.allowedTools.join(', ') || '(none)'}`,
    `Context: ${JSON.stringify(delivery.context)}`,
  ].join('\n')
}

function summarizeAgentRun(
  session: Session,
  firstSeq: SessionLogOffset,
): { text: string; reason: SessionEvent<'turn/end'>['data']['reason'] | undefined } {
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'assistant/message') {
      text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('') || text
    }
    if (event?.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Install the Runtime server as a Cordis plugin with disposal ownership. */
export function apply(ctx: Context, config: Config): void {
  const runtime = new WarningAgentRuntime(config, Date.now, new HarnessTaskExecutor(ctx))
  ctx.provide('warningAgentRuntime', runtime)
  ctx.effect(() => {
    void runtime.listen().catch(() => undefined)
    return () => { void runtime.close() }
  })
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const internals = { DELIVERY_PATH, MAX_BODY_BYTES, SIGNATURE_WINDOW_MS }
