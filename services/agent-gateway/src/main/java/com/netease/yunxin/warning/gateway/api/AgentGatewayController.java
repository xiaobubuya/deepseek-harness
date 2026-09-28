package com.netease.yunxin.warning.gateway.api;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.netease.yunxin.warning.gateway.client.ForwardResponse;
import com.netease.yunxin.warning.gateway.client.ForwardingClient;
import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import com.netease.yunxin.warning.gateway.security.HmacService;
import com.netease.yunxin.warning.gateway.security.NonceGuard;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.UUID;
import java.io.IOException;
import java.time.Instant;

import static org.springframework.http.HttpStatus.BAD_REQUEST;
import static org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE;
import static org.springframework.http.HttpStatus.UNAUTHORIZED;

@RestController
public final class AgentGatewayController {
    static final String EVENT_PATH = "/internal/agent-gateway/v1/task-events";
    static final String DELIVERY_PATH = "/internal/warning-agent/v1/deliveries";
    private static final String TASK_ID_PATTERN = "[A-Za-z0-9._:-]{1,128}";
    private static final String[] EVENT_STATUSES = {"ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED", "TIMEOUT", "CANCELLED"};

    private final GatewayProperties properties;
    private final ObjectMapper objectMapper;
    private final ForwardingClient forwardingClient;
    private final HmacService hmacService;
    private final NonceGuard nonceGuard;

    public AgentGatewayController(
            GatewayProperties properties,
            ObjectMapper objectMapper,
            ForwardingClient forwardingClient,
            HmacService hmacService,
            NonceGuard nonceGuard
    ) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.forwardingClient = forwardingClient;
        this.hmacService = hmacService;
        this.nonceGuard = nonceGuard;
    }

    @PostMapping("/api/v1/agent/tasks")
    public ResponseEntity<byte[]> submit(
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @RequestHeader(value = "X-Request-Id", required = false) String requestId,
            @Valid @RequestBody AgentTaskRequest task
    ) {
        byte[] body = write(task);
        enforceSize(body);
        return response(forwardingClient.postRuntime(DELIVERY_PATH, body, requestId(requestId)));
    }

    @PostMapping("/api/v1/agent/tasks/{taskId}/cancel")
    public ResponseEntity<byte[]> cancel(
            @PathVariable String taskId,
            @RequestHeader(value = "X-Internal-Token", required = false) String token,
            @RequestHeader(value = "X-Request-Id", required = false) String requestId,
            @Valid @RequestBody CancelTaskRequest request
    ) {
        if (!taskId.matches(TASK_ID_PATTERN)) throw new ResponseStatusException(BAD_REQUEST, "invalid taskId");
        byte[] body = write(request);
        enforceSize(body);
        String path = "/internal/warning-agent/v1/tasks/" + taskId + "/cancel";
        return response(forwardingClient.postRuntime(path, body, requestId(requestId)));
    }

    @PostMapping(EVENT_PATH)
    public ResponseEntity<byte[]> taskEvent(
            @RequestHeader(value = "X-Warning-Agent-Timestamp", required = false) String timestamp,
            @RequestHeader(value = "X-Warning-Agent-Nonce", required = false) String nonce,
            @RequestHeader(value = "X-Warning-Agent-Signature", required = false) String signature,
            @RequestHeader(value = "X-Request-Id", required = false) String requestId,
            @RequestBody byte[] body
    ) {
        enforceSize(body);
        if (timestamp == null || nonce == null || signature == null
                || !hmacService.verify("POST", EVENT_PATH, timestamp, nonce, body, signature)
                || !nonceGuard.accept(timestamp, nonce)) {
            throw new ResponseStatusException(UNAUTHORIZED, "invalid runtime signature");
        }
        validateTaskEvent(body);
        return response(forwardingClient.postWarningCenter(body, requestId(requestId)));
    }

    private void validateTaskEvent(byte[] body) {
        try {
            JsonNode event = objectMapper.readTree(body);
            if (event == null || !event.isObject()) {
                throw new ResponseStatusException(BAD_REQUEST, "invalid task event");
            }
            String eventType = event.path("eventType").asText();
            String status = event.path("status").asText();
            if (!"v1".equals(event.path("schemaVersion").asText())
                    || !hasBoundedText(event, "eventId", 128)
                    || !hasBoundedText(event, "taskId", 128)
                    || !hasBoundedText(event, "sessionId", 128)
                    || !hasBoundedText(event, "workflowId", 128)
                    || !event.path("revision").canConvertToInt() || event.path("revision").asInt() < 1
                    || !event.path("attempt").canConvertToInt() || event.path("attempt").asInt() < 1
                    || !("PROGRESS".equals(eventType) || "RESULT".equals(eventType))
                    || !isEventStatus(status)
                    || !event.path("occurredAt").isTextual()
                    || !isInstant(event.path("occurredAt").asText())
                    || !event.path("result").isObject()) {
                throw new ResponseStatusException(BAD_REQUEST, "invalid task event");
            }
        } catch (IOException error) {
            throw new ResponseStatusException(BAD_REQUEST, "invalid task event", error);
        }
    }

    private static boolean hasBoundedText(JsonNode event, String field, int maxLength) {
        JsonNode value = event.path(field);
        return value.isTextual() && !value.asText().isBlank() && value.asText().length() <= maxLength;
    }

    private static boolean isEventStatus(String status) {
        for (String allowed : EVENT_STATUSES) if (allowed.equals(status)) return true;
        return false;
    }

    private static boolean isInstant(String value) {
        try {
            Instant.parse(value);
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private byte[] write(Object value) {
        try {
            return objectMapper.writeValueAsBytes(value);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("request serialization failed", error);
        }
    }

    private void enforceSize(byte[] body) {
        if (body.length > properties.maxRequestBytes()) {
            throw new ResponseStatusException(PAYLOAD_TOO_LARGE, "request body too large");
        }
    }

    private static String requestId(String requestId) {
        return requestId == null || requestId.isBlank() ? UUID.randomUUID().toString() : requestId;
    }

    private static ResponseEntity<byte[]> response(ForwardResponse response) {
        HttpHeaders headers = new HttpHeaders();
        headers.putAll(response.headers());
        return ResponseEntity.status(response.status()).headers(headers).body(response.body());
    }
}
