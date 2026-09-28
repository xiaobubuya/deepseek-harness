package com.netease.yunxin.warning.gateway.api;

import com.netease.yunxin.warning.gateway.client.ForwardingClient.GatewayTransportException;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

import java.util.UUID;

@RestControllerAdvice
public final class GatewayExceptionHandler {

    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<GatewayError> status(ResponseStatusException error, HttpServletRequest request) {
        return ResponseEntity.status(error.getStatusCode()).body(new GatewayError(
                error.getStatusCode().toString(), error.getReason(), requestId(request), false));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<GatewayError> validation(MethodArgumentNotValidException error, HttpServletRequest request) {
        return ResponseEntity.badRequest().body(new GatewayError(
                "invalid_request", "request validation failed", requestId(request), false));
    }

    @ExceptionHandler(GatewayTransportException.class)
    ResponseEntity<GatewayError> transport(GatewayTransportException error, HttpServletRequest request) {
        return ResponseEntity.status(502).body(new GatewayError(
                "downstream_unavailable", error.getMessage(), requestId(request), true));
    }

    private static String requestId(HttpServletRequest request) {
        String value = request.getHeader("X-Request-Id");
        return value == null || value.isBlank() ? UUID.randomUUID().toString() : value;
    }
}
