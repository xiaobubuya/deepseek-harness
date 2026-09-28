package com.netease.yunxin.warning.gateway.api;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

public record AgentTaskRequest(
        @Pattern(regexp = "v1") String schemaVersion,
        @NotBlank @Size(max = 128) String taskId,
        @Size(max = 128) String incidentId,
        @NotBlank @Size(max = 64) String taskType,
        @Min(1) int revision,
        @Min(1) int attempt,
        @Pattern(regexp = "P[1-3]") String priority,
        @NotNull OffsetDateTime deadlineAt,
        @NotNull @Size(max = 32) List<@NotBlank @Size(max = 64) String> allowedTools,
        @NotNull @Size(max = 64) Map<String, Object> context,
        ActionGrant actionGrant
) {
    public record ActionGrant(boolean popoTeam) {
    }
}
