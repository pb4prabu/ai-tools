package com.acme.payment.domain;

/** Payment lifecycle states. */
public enum PaymentStatus {
    PENDING,
    COMPLETED,
    FAILED,
    PARTIALLY_REFUNDED,
    REFUNDED
}
