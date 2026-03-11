package com.acme.shared.events;

import java.math.BigDecimal;

/**
 * Published when a payment is successfully processed.
 * Consumed by order-service to update order status.
 */
public class PaymentCompletedEvent extends DomainEvent {
    private final String paymentId;
    private final BigDecimal amount;
    private final String paymentMethod;

    public PaymentCompletedEvent(String orderId, String paymentId, BigDecimal amount, String paymentMethod) {
        super(orderId);
        this.paymentId = paymentId;
        this.amount = amount;
        this.paymentMethod = paymentMethod;
    }

    public String getPaymentId() { return paymentId; }
    public BigDecimal getAmount() { return amount; }
    public String getPaymentMethod() { return paymentMethod; }
}
