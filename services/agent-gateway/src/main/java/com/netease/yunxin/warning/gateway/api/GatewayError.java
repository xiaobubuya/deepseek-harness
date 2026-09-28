package com.netease.yunxin.warning.gateway.api;

public record GatewayError(String code, String message, String requestId, boolean retryable) {
}
