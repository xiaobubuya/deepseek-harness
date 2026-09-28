package com.netease.yunxin.warning.gateway.api;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CancelTaskRequest(
        @Min(1) int revision,
        @Min(1) int attempt,
        @NotBlank @Size(max = 256) String reason
) {
}
