package com.acme.order.port;

import java.math.BigDecimal;

/**
 * Outbound port for payment processing.
 * Implemented by Stripe/PayPal adapter in infrastructure layer.
 */
public interface PaymentGateway {
    /**
     * Initiates a payment charge for the given order.
     * @param orderId unique order identifier
     * @param amount the amount to charge
     * @param currency ISO 4217 currency code
     * @param paymentMethodId tokenized payment method
     * @return payment transaction ID
     * @throws PaymentDeclinedException if the charge is declined
     */
    String charge(String orderId, BigDecimal amount, String currency, String paymentMethodId);

    /**
     * Refunds a previously completed payment.
     * @param transactionId the original payment transaction ID
     * @param amount the amount to refund (partial refunds supported)
     * @return refund transaction ID
     */
    String refund(String transactionId, BigDecimal amount);
}
