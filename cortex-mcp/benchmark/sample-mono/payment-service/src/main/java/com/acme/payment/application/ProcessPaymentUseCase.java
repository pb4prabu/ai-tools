package com.acme.payment.application;

import com.acme.payment.domain.Payment;
import com.acme.payment.port.PaymentRepository;
import com.acme.payment.port.StripeGateway;
import com.acme.shared.events.PaymentCompletedEvent;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

/**
 * Processes payments through the payment gateway:
 * 1. Creates payment record in PENDING state
 * 2. Calls Stripe to charge the payment method
 * 3. Updates payment status based on gateway response
 * 4. Publishes PaymentCompletedEvent on success
 */
@Service
public class ProcessPaymentUseCase {
    private final PaymentRepository paymentRepository;
    private final StripeGateway stripeGateway;

    public ProcessPaymentUseCase(PaymentRepository paymentRepository, StripeGateway stripeGateway) {
        this.paymentRepository = paymentRepository;
        this.stripeGateway = stripeGateway;
    }

    @Transactional
    public Payment execute(String orderId, String customerId, BigDecimal amount,
                           String currency, String paymentMethodId) {
        Payment payment = new Payment(orderId, customerId, amount, currency, paymentMethodId);
        payment = paymentRepository.save(payment);

        StripeGateway.ChargeResult result = stripeGateway.charge(
            paymentMethodId, amount, currency, payment.getId());

        if (result.success()) {
            payment.complete(result.chargeId());
        } else {
            payment.fail(result.failureMessage());
        }

        return paymentRepository.save(payment);
    }
}
