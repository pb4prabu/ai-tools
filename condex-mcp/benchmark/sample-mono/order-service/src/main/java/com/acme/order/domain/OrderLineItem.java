package com.acme.order.domain;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * Represents a single line item within an order.
 * Immutable value object — quantity and price cannot change after creation.
 */
public class OrderLineItem {
    private final String id;
    private final String productId;
    private final String productName;
    private final int quantity;
    private final BigDecimal unitPrice;

    public OrderLineItem(String productId, String productName, int quantity, BigDecimal unitPrice) {
        if (quantity < 1) throw new IllegalArgumentException("Quantity must be >= 1");
        if (unitPrice.compareTo(BigDecimal.ZERO) <= 0) throw new IllegalArgumentException("Unit price must be > 0");
        this.id = UUID.randomUUID().toString();
        this.productId = productId;
        this.productName = productName;
        this.quantity = quantity;
        this.unitPrice = unitPrice;
    }

    public BigDecimal getSubtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }

    public String getId() { return id; }
    public String getProductId() { return productId; }
    public String getProductName() { return productName; }
    public int getQuantity() { return quantity; }
    public BigDecimal getUnitPrice() { return unitPrice; }
}
