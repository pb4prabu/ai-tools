package com.acme.order.application;

import com.acme.order.domain.Order;
import com.acme.order.port.EventPublisher;
import com.acme.order.port.InventoryClient;
import com.acme.order.port.OrderRepository;
import com.acme.shared.events.OrderCreatedEvent;
import com.acme.shared.exception.BusinessRuleViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.stream.Collectors;

/**
 * Handles the complete order creation workflow:
 * 1. Validates product availability via inventory service
 * 2. Creates order aggregate with line items
 * 3. Reserves inventory
 * 4. Persists order
 * 5. Publishes OrderCreatedEvent
 */
@Service
public class CreateOrderUseCase {
    private final OrderRepository orderRepository;
    private final InventoryClient inventoryClient;
    private final EventPublisher eventPublisher;

    public CreateOrderUseCase(OrderRepository orderRepository,
                              InventoryClient inventoryClient,
                              EventPublisher eventPublisher) {
        this.orderRepository = orderRepository;
        this.inventoryClient = inventoryClient;
        this.eventPublisher = eventPublisher;
    }

    @Transactional
    public Order execute(CreateOrderCommand command) {
        // Check inventory
        Map<String, Integer> requested = command.items().stream()
            .collect(Collectors.toMap(CreateOrderCommand.Item::productId, CreateOrderCommand.Item::quantity));
        Map<String, Integer> available = inventoryClient.checkAvailability(requested);

        for (var entry : requested.entrySet()) {
            int avail = available.getOrDefault(entry.getKey(), 0);
            if (avail < entry.getValue()) {
                throw new BusinessRuleViolationException(
                    "INSUFFICIENT_INVENTORY",
                    "Product " + entry.getKey() + " has only " + avail + " available",
                    entry.getKey()
                );
            }
        }

        // Create order
        Order order = new Order(command.customerId(), command.shippingAddress(), command.currency());
        for (var item : command.items()) {
            order.addLineItem(item.productId(), item.productName(), item.quantity(), item.unitPrice());
        }

        // Reserve inventory
        inventoryClient.reserveInventory(order.getId(), requested);

        // Persist
        Order saved = orderRepository.save(order);

        // Publish event
        eventPublisher.publish(new OrderCreatedEvent(
            saved.getId(), saved.getCustomerId(), saved.getTotalAmount(), saved.getCurrency()
        ));

        return saved;
    }
}
