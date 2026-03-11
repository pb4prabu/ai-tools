package com.acme.order.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * Order aggregate root. Manages order lifecycle from creation through
 * fulfillment or cancellation. Enforces invariants:
 * - Order must have at least one line item
 * - Total must equal sum of line items
 * - Only PENDING orders can be cancelled
 * - Only PAID orders can be shipped
 */
public class Order {
    private final String id;
    private final String customerId;
    private final List<OrderLineItem> lineItems;
    private OrderStatus status;
    private BigDecimal totalAmount;
    private String currency;
    private String shippingAddress;
    private String trackingNumber;
    private Instant createdAt;
    private Instant updatedAt;

    public Order(String customerId, String shippingAddress, String currency) {
        this.id = UUID.randomUUID().toString();
        this.customerId = customerId;
        this.shippingAddress = shippingAddress;
        this.currency = currency;
        this.lineItems = new ArrayList<>();
        this.status = OrderStatus.PENDING;
        this.totalAmount = BigDecimal.ZERO;
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    /**
     * Adds a line item to the order and recalculates total.
     * @throws IllegalStateException if order is not in PENDING status
     */
    public void addLineItem(String productId, String productName, int quantity, BigDecimal unitPrice) {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Cannot modify order in " + status + " status");
        }
        OrderLineItem item = new OrderLineItem(productId, productName, quantity, unitPrice);
        lineItems.add(item);
        recalculateTotal();
    }

    /**
     * Removes a line item by product ID.
     * @throws IllegalStateException if order is not PENDING or would become empty
     */
    public void removeLineItem(String productId) {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Cannot modify order in " + status + " status");
        }
        boolean removed = lineItems.removeIf(item -> item.getProductId().equals(productId));
        if (!removed) throw new IllegalArgumentException("Product not in order: " + productId);
        if (lineItems.isEmpty()) throw new IllegalStateException("Order must have at least one item");
        recalculateTotal();
    }

    /**
     * Marks order as paid after successful payment processing.
     * @throws IllegalStateException if order is not in PENDING status
     */
    public void markPaid() {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only PENDING orders can be paid");
        }
        this.status = OrderStatus.PAID;
        this.updatedAt = Instant.now();
    }

    /**
     * Marks order as shipped with tracking information.
     * @throws IllegalStateException if order is not in PAID status
     */
    public void markShipped(String trackingNumber) {
        if (status != OrderStatus.PAID) {
            throw new IllegalStateException("Only PAID orders can be shipped");
        }
        this.trackingNumber = trackingNumber;
        this.status = OrderStatus.SHIPPED;
        this.updatedAt = Instant.now();
    }

    /**
     * Cancels the order. Only PENDING orders can be cancelled.
     * @throws IllegalStateException if order is not in PENDING status
     */
    public void cancel() {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only PENDING orders can be cancelled");
        }
        this.status = OrderStatus.CANCELLED;
        this.updatedAt = Instant.now();
    }

    private void recalculateTotal() {
        this.totalAmount = lineItems.stream()
            .map(OrderLineItem::getSubtotal)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        this.updatedAt = Instant.now();
    }

    public String getId() { return id; }
    public String getCustomerId() { return customerId; }
    public OrderStatus getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public String getCurrency() { return currency; }
    public String getShippingAddress() { return shippingAddress; }
    public String getTrackingNumber() { return trackingNumber; }
    public List<OrderLineItem> getLineItems() { return Collections.unmodifiableList(lineItems); }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
