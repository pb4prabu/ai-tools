package com.acme.order.application;

import com.acme.order.domain.Order;
import com.acme.order.domain.OrderStatus;
import com.acme.order.port.OrderRepository;
import com.acme.shared.exception.ResourceNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Read-only query service for order retrieval.
 * Separates read and write concerns (CQRS-lite).
 */
@Service
@Transactional(readOnly = true)
public class GetOrderQueryService {
    private final OrderRepository orderRepository;

    public GetOrderQueryService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public Order getById(String orderId) {
        return orderRepository.findById(orderId)
            .orElseThrow(() -> new ResourceNotFoundException("Order", orderId));
    }

    public List<Order> getByCustomer(String customerId) {
        return orderRepository.findByCustomerId(customerId);
    }

    public List<Order> getByCustomerAndStatus(String customerId, OrderStatus status) {
        return orderRepository.findByCustomerIdAndStatus(customerId, status);
    }

    public long countByStatus(OrderStatus status) {
        return orderRepository.countByStatus(status);
    }
}
