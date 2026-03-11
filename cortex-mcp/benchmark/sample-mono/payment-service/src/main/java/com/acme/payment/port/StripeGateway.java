package com.acme.payment.port;

import java.math.BigDecimal;

/**
 * Outbound port for Stripe payment processing.
 */
public interface StripeGateway {
    ChargeResult charge(String paymentMethodId, BigDecimal amount, String currency, String idempotencyKey);
    RefundResult refund(String chargeId, BigDecimal amount);

    record ChargeResult(String chargeId, boolean success, String failureMessage) {}
    record RefundResult(String refundId, boolean success) {}
}
