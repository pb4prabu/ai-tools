package com.acme.payment.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Payment aggregate root. Represents a payment transaction.
 * Tracks the lifecycle from initiation through completion or failure.
 *
 * Invariants:
 * - Amount must be positive
 * - Only PENDING payments can be completed or failed
 * - Completed payments can be refunded (full or partial)
 */
public class Payment {
    private final String id;
    private final String orderId;
    private final String customerId;
    private final BigDecimal amount;
    private final String currency;
    private PaymentStatus status;
    private String paymentMethod;
    private String gatewayTransactionId;
    private String failureReason;
    private BigDecimal refundedAmount;
    private Instant createdAt;
    private Instant completedAt;

    public Payment(String orderId, String customerId, BigDecimal amount, String currency, String paymentMethod) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new IllegalArgumentException("Payment amount must be positive");
        }
        this.id = UUID.randomUUID().toString();
        this.orderId = orderId;
        this.customerId = customerId;
        this.amount = amount;
        this.currency = currency;
        this.paymentMethod = paymentMethod;
        this.status = PaymentStatus.PENDING;
        this.refundedAmount = BigDecimal.ZERO;
        this.createdAt = Instant.now();
    }

    /**
     * Marks payment as successfully completed.
     * @param gatewayTransactionId the transaction ID from payment gateway
     */
    public void complete(String gatewayTransactionId) {
        if (status != PaymentStatus.PENDING) {
            throw new IllegalStateException("Only PENDING payments can be completed");
        }
        this.gatewayTransactionId = gatewayTransactionId;
        this.status = PaymentStatus.COMPLETED;
        this.completedAt = Instant.now();
    }

    /**
     * Marks payment as failed.
     * @param reason description of why the payment failed
     */
    public void fail(String reason) {
        if (status != PaymentStatus.PENDING) {
            throw new IllegalStateException("Only PENDING payments can fail");
        }
        this.failureReason = reason;
        this.status = PaymentStatus.FAILED;
    }

    /**
     * Processes a refund for the specified amount.
     * @param refundAmount amount to refund (must not exceed remaining refundable amount)
     */
    public void refund(BigDecimal refundAmount) {
        if (status != PaymentStatus.COMPLETED && status != PaymentStatus.PARTIALLY_REFUNDED) {
            throw new IllegalStateException("Can only refund completed payments");
        }
        BigDecimal maxRefundable = amount.subtract(refundedAmount);
        if (refundAmount.compareTo(maxRefundable) > 0) {
            throw new IllegalArgumentException("Refund amount exceeds remaining: " + maxRefundable);
        }
        this.refundedAmount = this.refundedAmount.add(refundAmount);
        this.status = this.refundedAmount.compareTo(amount) >= 0
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;
    }

    public String getId() { return id; }
    public String getOrderId() { return orderId; }
    public String getCustomerId() { return customerId; }
    public BigDecimal getAmount() { return amount; }
    public String getCurrency() { return currency; }
    public PaymentStatus getStatus() { return status; }
    public String getPaymentMethod() { return paymentMethod; }
    public String getGatewayTransactionId() { return gatewayTransactionId; }
    public String getFailureReason() { return failureReason; }
    public BigDecimal getRefundedAmount() { return refundedAmount; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getCompletedAt() { return completedAt; }
}
