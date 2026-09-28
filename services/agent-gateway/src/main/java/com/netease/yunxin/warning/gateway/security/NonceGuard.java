package com.netease.yunxin.warning.gateway.security;

import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

@Component
public final class NonceGuard {
    private final ConcurrentHashMap<String, Instant> nonces = new ConcurrentHashMap<>();
    private final GatewayProperties properties;
    private final Clock clock;

    @Autowired
    public NonceGuard(GatewayProperties properties) {
        this(properties, Clock.systemUTC());
    }

    NonceGuard(GatewayProperties properties, Clock clock) {
        this.properties = properties;
        this.clock = clock;
    }

    public boolean accept(String timestamp, String nonce) {
        long timestampMillis;
        try {
            timestampMillis = Long.parseLong(timestamp);
        } catch (NumberFormatException error) {
            return false;
        }
        Instant now = clock.instant();
        Instant sentAt = Instant.ofEpochMilli(timestampMillis);
        if (sentAt.isBefore(now.minus(properties.signatureWindow()))
                || sentAt.isAfter(now.plus(properties.signatureWindow()))) {
            return false;
        }
        nonces.entrySet().removeIf(entry -> !entry.getValue().isAfter(now));
        return nonces.putIfAbsent(nonce, now.plus(properties.nonceTtl())) == null;
    }
}
