package com.acme.order.port;

import com.acme.order.domain.Order;
import com.acme.order.domain.OrderStatus;
import java.util.List;
import java.util.Optional;

/**
 * Outbound port for order persistence.
 * Implemented by JPA adapter in infrastructure layer.
 */
public interface OrderRepository {
    Order save(Order order);
    Optional<Order> findById(String id);
    List<Order> findByCustomerId(String customerId);
    List<Order> findByStatus(OrderStatus status);
    List<Order> findByCustomerIdAndStatus(String customerId, OrderStatus status);
    void deleteById(String id);
    long countByStatus(OrderStatus status);
}
