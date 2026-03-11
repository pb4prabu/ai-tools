package com.acme.payment.port;

import com.acme.payment.domain.Payment;
import com.acme.payment.domain.PaymentStatus;
import java.util.List;
import java.util.Optional;

/** Outbound port for payment persistence. */
public interface PaymentRepository {
    Payment save(Payment payment);
    Optional<Payment> findById(String id);
    Optional<Payment> findByOrderId(String orderId);
    List<Payment> findByCustomerId(String customerId);
    List<Payment> findByStatus(PaymentStatus status);
}
