package com.acme.payment.web;

import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;

public record RefundRequest(@Positive BigDecimal amount) {}
