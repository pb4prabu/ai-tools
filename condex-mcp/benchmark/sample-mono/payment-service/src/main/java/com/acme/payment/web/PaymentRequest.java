package com.acme.payment.web;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;

public record PaymentRequest(
    @NotBlank String orderId,
    @NotBlank String customerId,
    @Positive BigDecimal amount,
    @NotBlank String currency,
    @NotBlank String paymentMethodId
) {}
