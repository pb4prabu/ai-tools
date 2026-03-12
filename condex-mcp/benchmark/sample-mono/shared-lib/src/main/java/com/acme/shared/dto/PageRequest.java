package com.acme.shared.dto;

/**
 * Standard pagination request parameters.
 * Used across all REST endpoints that return paginated results.
 */
public record PageRequest(int page, int size, String sortBy, String sortDirection) {
    public PageRequest {
        if (page < 0) throw new IllegalArgumentException("Page must be >= 0");
        if (size < 1 || size > 100) throw new IllegalArgumentException("Size must be 1-100");
    }

    public static PageRequest of(int page, int size) {
        return new PageRequest(page, size, "id", "ASC");
    }

    public int offset() { return page * size; }
}
