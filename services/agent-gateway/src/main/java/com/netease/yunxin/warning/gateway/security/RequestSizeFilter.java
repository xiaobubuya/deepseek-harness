package com.netease.yunxin.warning.gateway.security;

import com.netease.yunxin.warning.gateway.config.GatewayProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.io.IOException;

/** Rejects oversized requests before Spring/Jackson buffers the body. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public final class RequestSizeFilter extends org.springframework.web.filter.OncePerRequestFilter {
    private final int maxRequestBytes;

    public RequestSizeFilter(GatewayProperties properties) {
        this.maxRequestBytes = properties.maxRequestBytes();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long contentLength = request.getContentLengthLong();
        if (contentLength > maxRequestBytes) {
            response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE, "request body too large");
            return;
        }
        chain.doFilter(request, response);
    }
}
