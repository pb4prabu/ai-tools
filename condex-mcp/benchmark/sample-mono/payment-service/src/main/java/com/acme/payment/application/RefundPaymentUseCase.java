package com.acme.payment.application;

import com.acme.payment.domain.Payment;
import com.acme.payment.port.PaymentRepository;
import com.acme.payment.port.StripeGateway;
import com.acme.shared.exception.ResourceNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

/**
 * Handles payment refunds (full or partial):
 * 1. Validates payment exists and is refundable
 * 2. Calls Stripe to process refund
 * 3. Updates payment aggregate with refund details
 */
@Service
public class RefundPaymentUseCase {
    private final PaymentRepository paymentRepository;
    private final StripeGateway stripeGateway;

    public RefundPaymentUseCase(PaymentRepository paymentRepository, StripeGateway stripeGateway) {
        this.paymentRepository = paymentRepository;
        this.stripeGateway = stripeGateway;
    }

    @Transactional
    public Payment execute(String paymentId, BigDecimal refundAmount) {
        Payment payment = paymentRepository.findById(paymentId)
            .orElseThrow(() -> new ResourceNotFoundException("Payment", paymentId));

        StripeGateway.RefundResult result = stripeGateway.refund(
            payment.getGatewayTransactionId(), refundAmount);

        if (result.success()) {
            payment.refund(refundAmount);
        }

        return paymentRepository.save(payment);
    }
}
