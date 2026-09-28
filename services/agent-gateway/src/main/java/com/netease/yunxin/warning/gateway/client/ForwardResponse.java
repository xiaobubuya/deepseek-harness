package com.netease.yunxin.warning.gateway.client;

import org.springframework.http.HttpHeaders;

public record ForwardResponse(int status, HttpHeaders headers, byte[] body) {
}
