package com.netease.yunxin.warning.gateway.security;

import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

@Component
public final class HmacService {
    private static final String ALGORITHM = "HmacSHA256";
    private final byte[] secret;

    public HmacService(GatewayProperties properties) {
        this.secret = properties.sharedSecret().getBytes(StandardCharsets.UTF_8);
    }

    public String sign(String method, String path, String timestamp, String nonce, byte[] body) {
        String prefix = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n";
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(new SecretKeySpec(secret, ALGORITHM));
            mac.update(prefix.getBytes(StandardCharsets.UTF_8));
            return "sha256=" + HexFormat.of().formatHex(mac.doFinal(body));
        } catch (Exception error) {
            throw new IllegalStateException("HMAC-SHA256 is unavailable", error);
        }
    }

    public boolean verify(String method, String path, String timestamp, String nonce, byte[] body, String signature) {
        byte[] expected = sign(method, path, timestamp, nonce, body).getBytes(StandardCharsets.US_ASCII);
        byte[] actual = signature.getBytes(StandardCharsets.US_ASCII);
        return MessageDigest.isEqual(expected, actual);
    }
}
