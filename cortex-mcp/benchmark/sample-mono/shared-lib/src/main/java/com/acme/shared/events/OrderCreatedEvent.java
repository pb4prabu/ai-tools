package com.acme.shared.events;

import java.math.BigDecimal;

/**
 * Published when a new order is successfully created.
 * Consumed by payment-service and notification-service.
 */
public class OrderCreatedEvent extends DomainEvent {
    private final String customerId;
    private final BigDecimal totalAmount;
    private final String currency;

    public OrderCreatedEvent(String orderId, String customerId, BigDecimal totalAmount, String currency) {
        super(orderId);
        this.customerId = customerId;
        this.totalAmount = totalAmount;
        this.currency = currency;
    }

    public String getCustomerId() { return customerId; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public String getCurrency() { return currency; }
}
