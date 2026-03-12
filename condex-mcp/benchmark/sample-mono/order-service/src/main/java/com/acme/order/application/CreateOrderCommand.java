package com.acme.order.application;

import java.math.BigDecimal;
import java.util.List;

/**
 * Command object for creating a new order.
 * Validated at the controller layer before reaching the use case.
 */
public record CreateOrderCommand(
    String customerId,
    String shippingAddress,
    String currency,
    List<Item> items
) {
    public record Item(
        String productId,
        String productName,
        int quantity,
        BigDecimal unitPrice
    ) {}
}
