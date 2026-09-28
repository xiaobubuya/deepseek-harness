package com.netease.yunxin.warning.gateway.config;

import jakarta.annotation.PostConstruct;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.net.URI;
import java.time.Duration;

@Validated
@ConfigurationProperties(prefix = "agent-gateway")
public record GatewayProperties(
        @NotBlank String runtimeBaseUrl,
        @NotBlank String warningCenterCallbackUrl,
        @NotBlank String warningCenterToken,
        @NotBlank String sharedSecret,
        @Min(1024) int maxRequestBytes,
        @Min(1) int maxConcurrentRequests,
        @Min(1) int retryAfterSeconds,
        Duration connectTimeout,
        Duration requestTimeout,
        Duration signatureWindow,
        Duration nonceTtl
) {
    @PostConstruct
    void validate() {
        requireHttpUri(runtimeBaseUrl, "runtimeBaseUrl");
        requireHttpUri(warningCenterCallbackUrl, "warningCenterCallbackUrl");
        if (connectTimeout.isNegative() || connectTimeout.isZero()
                || requestTimeout.isNegative() || requestTimeout.isZero()
                || signatureWindow.isNegative() || signatureWindow.isZero()
                || nonceTtl.isNegative() || nonceTtl.isZero()) {
            throw new IllegalArgumentException("gateway durations must be positive");
        }
    }

    private static void requireHttpUri(String value, String name) {
        URI uri = URI.create(value);
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null) {
            throw new IllegalArgumentException(name + " must be an absolute HTTP(S) URI");
        }
    }
}
