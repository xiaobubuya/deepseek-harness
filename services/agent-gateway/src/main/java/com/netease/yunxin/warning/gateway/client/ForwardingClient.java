package com.netease.yunxin.warning.gateway.client;

import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import com.netease.yunxin.warning.gateway.security.HmacService;
import org.springframework.http.HttpHeaders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Semaphore;

@Component
public final class ForwardingClient {
    private final GatewayProperties properties;
    private final HmacService hmacService;
    private final HttpClient httpClient;
    private final Semaphore capacity;
    private final Clock clock;

    @Autowired
    public ForwardingClient(GatewayProperties properties, HmacService hmacService) {
        this(properties, hmacService, HttpClient.newBuilder()
                .connectTimeout(properties.connectTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build(), Clock.systemUTC());
    }

    ForwardingClient(GatewayProperties properties, HmacService hmacService, HttpClient httpClient, Clock clock) {
        this.properties = properties;
        this.hmacService = hmacService;
        this.httpClient = httpClient;
        this.capacity = new Semaphore(properties.maxConcurrentRequests());
        this.clock = clock;
    }

    public ForwardResponse postRuntime(String path, byte[] body, String requestId) {
        String timestamp = Long.toString(clock.millis());
        String nonce = UUID.randomUUID().toString();
        HttpRequest request = HttpRequest.newBuilder(URI.create(properties.runtimeBaseUrl()).resolve(path))
                .timeout(properties.requestTimeout())
                .header(HttpHeaders.CONTENT_TYPE, "application/json")
                .header("X-Request-Id", requestId)
                .header("X-Warning-Agent-Timestamp", timestamp)
                .header("X-Warning-Agent-Nonce", nonce)
                .header("X-Warning-Agent-Signature", hmacService.sign("POST", path, timestamp, nonce, body))
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        return execute(request);
    }

    public ForwardResponse postWarningCenter(byte[] body, String requestId) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(properties.warningCenterCallbackUrl()))
                .timeout(properties.requestTimeout())
                .header(HttpHeaders.CONTENT_TYPE, "application/json")
                .header("X-Request-Id", requestId)
                .header("X-Internal-Token", properties.warningCenterToken())
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        return execute(request);
    }

    private ForwardResponse execute(HttpRequest request) {
        if (!capacity.tryAcquire()) {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.RETRY_AFTER, Integer.toString(properties.retryAfterSeconds()));
            return new ForwardResponse(429, headers, "{\"code\":\"gateway_busy\",\"retryable\":true}".getBytes(StandardCharsets.UTF_8));
        }
        try {
            HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            HttpHeaders headers = new HttpHeaders();
            copy(response.headers().allValues(HttpHeaders.CONTENT_TYPE), HttpHeaders.CONTENT_TYPE, headers);
            copy(response.headers().allValues(HttpHeaders.RETRY_AFTER), HttpHeaders.RETRY_AFTER, headers);
            copy(response.headers().allValues("X-Request-Id"), "X-Request-Id", headers);
            return new ForwardResponse(response.statusCode(), headers, response.body());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new GatewayTransportException("forwarding interrupted", error);
        } catch (IOException error) {
            throw new GatewayTransportException("downstream unavailable", error);
        } finally {
            capacity.release();
        }
    }

    private static void copy(List<String> values, String name, HttpHeaders headers) {
        if (!values.isEmpty()) headers.put(name, values);
    }

    public static final class GatewayTransportException extends RuntimeException {
        GatewayTransportException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
