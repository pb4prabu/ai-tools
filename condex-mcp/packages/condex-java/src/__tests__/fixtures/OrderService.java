package com.app.order.application;

import com.app.order.domain.Order;
import com.app.order.domain.OrderRepository;
import org.springframework.stereotype.Service;

/**
 * Handles order creation, validation, and lifecycle management.
 * Implements the CreateOrderUseCase port.
 */
@Service
public class OrderService implements CreateOrderUseCase {

    private static final String ORDER_PREFIX = "ORD-";
    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    /**
     * Create a new order with the given items.
     * @param items the items to include
     * @return the created order
     * @throws ValidationException if items are invalid
     */
    public Order createOrder(List<OrderItem> items) throws ValidationException {
        validateItems(items);
        Order order = Order.create(items);
        return orderRepository.save(order);
    }

    public Order getOrderById(String orderId) {
        return orderRepository.findById(orderId)
            .orElseThrow(() -> new OrderNotFoundException(orderId));
    }

    private void validateItems(List<OrderItem> items) throws ValidationException {
        if (items == null || items.isEmpty()) {
            throw new ValidationException("Order must have at least one item");
        }
    }

    public enum OrderStatus {
        PENDING,
        CONFIRMED,
        SHIPPED,
        DELIVERED
    }
}
