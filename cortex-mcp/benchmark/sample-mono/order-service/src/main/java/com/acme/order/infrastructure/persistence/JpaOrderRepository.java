package com.acme.order.infrastructure.persistence;

import com.acme.order.domain.Order;
import com.acme.order.domain.OrderStatus;
import com.acme.order.port.OrderRepository;
import org.springframework.stereotype.Repository;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * JPA-backed implementation of OrderRepository.
 * Uses in-memory map for simplicity (would use Spring Data JPA in production).
 */
@Repository
public class JpaOrderRepository implements OrderRepository {
    private final Map<String, Order> store = new ConcurrentHashMap<>();

    @Override
    public Order save(Order order) {
        store.put(order.getId(), order);
        return order;
    }

    @Override
    public Optional<Order> findById(String id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public List<Order> findByCustomerId(String customerId) {
        return store.values().stream()
            .filter(o -> o.getCustomerId().equals(customerId))
            .collect(Collectors.toList());
    }

    @Override
    public List<Order> findByStatus(OrderStatus status) {
        return store.values().stream()
            .filter(o -> o.getStatus() == status)
            .collect(Collectors.toList());
    }

    @Override
    public List<Order> findByCustomerIdAndStatus(String customerId, OrderStatus status) {
        return store.values().stream()
            .filter(o -> o.getCustomerId().equals(customerId) && o.getStatus() == status)
            .collect(Collectors.toList());
    }

    @Override
    public void deleteById(String id) {
        store.remove(id);
    }

    @Override
    public long countByStatus(OrderStatus status) {
        return store.values().stream().filter(o -> o.getStatus() == status).count();
    }
}
