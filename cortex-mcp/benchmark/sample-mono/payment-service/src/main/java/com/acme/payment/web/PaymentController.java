package com.acme.payment.web;

import com.acme.payment.application.ProcessPaymentUseCase;
import com.acme.payment.application.RefundPaymentUseCase;
import com.acme.payment.domain.Payment;
import com.acme.shared.dto.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;

/**
 * REST API for payment operations.
 * Base path: /api/v1/payments
 */
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {
    private final ProcessPaymentUseCase processPayment;
    private final RefundPaymentUseCase refundPayment;

    public PaymentController(ProcessPaymentUseCase processPayment, RefundPaymentUseCase refundPayment) {
        this.processPayment = processPayment;
        this.refundPayment = refundPayment;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<Payment> processPayment(@Valid @RequestBody PaymentRequest request) {
        Payment payment = processPayment.execute(
            request.orderId(), request.customerId(), request.amount(),
            request.currency(), request.paymentMethodId());
        return ApiResponse.ok(payment);
    }

    @PostMapping("/{paymentId}/refund")
    public ApiResponse<Payment> refundPayment(
            @PathVariable String paymentId,
            @RequestBody RefundRequest request) {
        Payment payment = refundPayment.execute(paymentId, request.amount());
        return ApiResponse.ok(payment);
    }
}
