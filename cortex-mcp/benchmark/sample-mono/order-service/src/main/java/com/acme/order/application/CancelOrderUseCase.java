package com.acme.order.application;

import com.acme.order.domain.Order;
import com.acme.order.port.EventPublisher;
import com.acme.order.port.InventoryClient;
import com.acme.order.port.OrderRepository;
import com.acme.shared.exception.ResourceNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Handles order cancellation:
 * 1. Validates order exists and is cancellable
 * 2. Cancels the order aggregate
 * 3. Releases reserved inventory
 * 4. Persists updated order
 */
@Service
public class CancelOrderUseCase {
    private final OrderRepository orderRepository;
    private final InventoryClient inventoryClient;
    private final EventPublisher eventPublisher;

    public CancelOrderUseCase(OrderRepository orderRepository,
                              InventoryClient inventoryClient,
                              EventPublisher eventPublisher) {
        this.orderRepository = orderRepository;
        this.inventoryClient = inventoryClient;
        this.eventPublisher = eventPublisher;
    }

    @Transactional
    public Order execute(String orderId) {
        Order order = orderRepository.findById(orderId)
            .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));

        order.cancel();
        inventoryClient.releaseInventory(orderId);
        return orderRepository.save(order);
    }
}
