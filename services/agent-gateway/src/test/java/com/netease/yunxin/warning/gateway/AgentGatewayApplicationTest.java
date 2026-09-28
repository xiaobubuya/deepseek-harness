package com.netease.yunxin.warning.gateway;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AgentGatewayApplicationTest {
    private static final String SECRET = "test-shared-secret";
    private static final String TOKEN = "test-warning-center-token";
    private static final HttpServer RUNTIME = server();
    private static final HttpServer WARNING_CENTER = server();
    private static final AtomicReference<CapturedRequest> RUNTIME_REQUEST = new AtomicReference<>();
    private static final AtomicReference<CapturedRequest> WARNING_CENTER_REQUEST = new AtomicReference<>();

    static {
        RUNTIME.createContext("/", exchange -> capture(exchange, RUNTIME_REQUEST,
                202, "{\"accepted\":true,\"duplicate\":false}"));
        WARNING_CENTER.createContext("/", exchange -> capture(exchange, WARNING_CENTER_REQUEST,
                202, "{\"accepted\":true,\"duplicate\":false}"));
        RUNTIME.start();
        WARNING_CENTER.start();
    }

    @LocalServerPort
    private int port;

    private final HttpClient client = HttpClient.newHttpClient();

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("agent-gateway.runtime-base-url", () -> url(RUNTIME));
        registry.add("agent-gateway.warning-center-callback-url", () -> url(WARNING_CENTER) + "/task-events");
        registry.add("agent-gateway.warning-center-token", () -> TOKEN);
        registry.add("agent-gateway.shared-secret", () -> SECRET);
        registry.add("agent-gateway.max-request-bytes", () -> 262_144);
        registry.add("agent-gateway.max-concurrent-requests", () -> 8);
        registry.add("agent-gateway.retry-after-seconds", () -> 5);
        registry.add("agent-gateway.connect-timeout", () -> "1s");
        registry.add("agent-gateway.request-timeout", () -> "2s");
        registry.add("agent-gateway.signature-window", () -> "5m");
        registry.add("agent-gateway.nonce-ttl", () -> "5m");
    }

    @BeforeEach
    void reset() {
        RUNTIME_REQUEST.set(null);
        WARNING_CENTER_REQUEST.set(null);
    }

    @AfterAll
    static void stopServers() {
        RUNTIME.stop(0);
        WARNING_CENTER.stop(0);
    }

    @Test
    void forwardsTasksToTheFixedRuntimeWithHmac() throws Exception {
        String body = """
                {"schemaVersion":"v1","taskId":"task-1","incidentId":"incident-1","taskType":"investigate",\
                "revision":1,"attempt":1,"priority":"P1","deadlineAt":"2099-01-01T00:00:00Z",\
                "allowedTools":[],"context":{},"actionGrant":{"popoTeam":false}}
                """.replace("\n", "");
        HttpResponse<String> response = client.send(HttpRequest.newBuilder(gateway("/api/v1/agent/tasks"))
                .header("Content-Type", "application/json")
                .header("X-Internal-Token", TOKEN)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build(), HttpResponse.BodyHandlers.ofString());

        assertThat(response.statusCode()).isEqualTo(202);
        CapturedRequest captured = RUNTIME_REQUEST.get();
        assertThat(captured.path()).isEqualTo("/internal/warning-agent/v1/deliveries");
        assertThat(captured.signature()).startsWith("sha256=");
        assertThat(captured.body()).contains("\"taskId\":\"task-1\"");
    }

    @Test
    void rejectsInvalidWarningCenterCredentials() throws Exception {
        HttpResponse<String> response = client.send(HttpRequest.newBuilder(gateway("/api/v1/agent/tasks"))
                .header("Content-Type", "application/json")
                .header("X-Internal-Token", "wrong")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(RUNTIME_REQUEST.get()).isNull();
    }

    @Test
    void verifiesRuntimeCallbacksAndRejectsNonceReplay() throws Exception {
        String path = "/internal/agent-gateway/v1/task-events";
        String body = """
                {"schemaVersion":"v1","eventId":"event-1","eventType":"RESULT","taskId":"task-1",\
                "revision":1,"attempt":1,"sessionId":"session","workflowId":"workflow",\
                "status":"SUCCEEDED","occurredAt":"2026-09-17T08:00:00Z","result":{}}
                """.replace("\n", "");
        String timestamp = Long.toString(Instant.now().toEpochMilli());
        String nonce = "callback-nonce";
        String signature = sign("POST", path, timestamp, nonce, body);
        HttpRequest request = HttpRequest.newBuilder(gateway(path))
                .header("Content-Type", "application/json")
                .header("X-Warning-Agent-Timestamp", timestamp)
                .header("X-Warning-Agent-Nonce", nonce)
                .header("X-Warning-Agent-Signature", signature)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        assertThat(client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(202);
        assertThat(WARNING_CENTER_REQUEST.get().body()).isEqualTo(body);
        assertThat(WARNING_CENTER_REQUEST.get().internalToken()).isEqualTo(TOKEN);
        assertThat(client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
    }

    private URI gateway(String path) {
        return URI.create("http://127.0.0.1:" + port + path);
    }

    private static HttpServer server() {
        try {
            return HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    private static String url(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static void capture(HttpExchange exchange, AtomicReference<CapturedRequest> target, int status, String response) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        target.set(new CapturedRequest(exchange.getRequestURI().getPath(), body,
                exchange.getRequestHeaders().getFirst("X-Warning-Agent-Signature"),
                exchange.getRequestHeaders().getFirst("X-Internal-Token")));
        byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static String sign(String method, String path, String timestamp, String nonce, String body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String value = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + body;
        return "sha256=" + HexFormat.of().formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    }

    private record CapturedRequest(String path, String body, String signature, String internalToken) {
    }
}
