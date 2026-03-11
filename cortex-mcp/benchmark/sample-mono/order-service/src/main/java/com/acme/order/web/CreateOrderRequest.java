package com.acme.order.web;

import com.acme.order.application.CreateOrderCommand;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;

import java.math.BigDecimal;
import java.util.List;

/**
 * REST request body for creating an order.
 * Validates input before converting to domain command.
 */
public record CreateOrderRequest(
    @NotBlank String customerId,
    @NotBlank String shippingAddress,
    @NotBlank String currency,
    @NotEmpty List<LineItemRequest> items
) {
    public record LineItemRequest(
        @NotBlank String productId,
        @NotBlank String productName,
        @Positive int quantity,
        @Positive BigDecimal unitPrice
    ) {}

    public CreateOrderCommand toCommand() {
        return new CreateOrderCommand(
            customerId, shippingAddress, currency,
            items.stream().map(i -> new CreateOrderCommand.Item(
                i.productId(), i.productName(), i.quantity(), i.unitPrice()
            )).toList()
        );
    }
}
