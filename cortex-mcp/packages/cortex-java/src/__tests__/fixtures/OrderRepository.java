package com.app.order.domain;

import java.util.Optional;

/**
 * Port for persisting orders to the database.
 */
public interface OrderRepository {

    Order save(Order order);

    Optional<Order> findById(String id);

    void deleteById(String id);
}
