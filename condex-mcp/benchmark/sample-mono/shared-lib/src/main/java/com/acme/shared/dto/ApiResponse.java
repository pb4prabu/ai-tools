package com.acme.shared.dto;

import java.time.Instant;

/**
 * Standard API response wrapper providing consistent structure.
 * All REST endpoints return responses wrapped in this envelope.
 *
 * @param <T> the type of the response payload
 */
public record ApiResponse<T>(
    boolean success,
    T data,
    String message,
    Instant timestamp
) {
    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, data, null, Instant.now());
    }

    public static <T> ApiResponse<T> error(String message) {
        return new ApiResponse<>(false, null, message, Instant.now());
    }
}
