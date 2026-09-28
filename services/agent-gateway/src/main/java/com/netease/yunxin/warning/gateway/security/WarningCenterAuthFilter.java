package com.netease.yunxin.warning.gateway.security;

import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Component
public final class WarningCenterAuthFilter extends OncePerRequestFilter {
    private final byte[] expectedToken;

    public WarningCenterAuthFilter(GatewayProperties properties) {
        this.expectedToken = properties.warningCenterToken().getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/v1/agent/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String value = request.getHeader("X-Internal-Token");
        if (value == null || !MessageDigest.isEqual(expectedToken, value.getBytes(StandardCharsets.UTF_8))) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            response.getWriter().write("{\"code\":\"unauthorized\",\"message\":\"invalid warning center token\",\"retryable\":false}");
            return;
        }
        chain.doFilter(request, response);
    }
}
