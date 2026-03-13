package com.acme.order.domain;

/**
 * Order lifecycle states. Valid transitions:
 * PENDING → PAID → SHIPPED → DELIVERED
 * PENDING → CANCELLED
 * PAID → REFUNDED
 */
public enum OrderStatus {
    PENDING,
    PAID,
    SHIPPED,
    DELIVERED,
    CANCELLED,
    REFUNDED
}
