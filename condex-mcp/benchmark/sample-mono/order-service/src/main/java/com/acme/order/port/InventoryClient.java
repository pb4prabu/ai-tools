package com.acme.order.port;

import java.util.Map;

/**
 * Outbound port for inventory checks.
 * Calls inventory-service via REST/gRPC.
 */
public interface InventoryClient {
    /**
     * Checks availability of products.
     * @param productQuantities map of productId to requested quantity
     * @return map of productId to available quantity
     */
    Map<String, Integer> checkAvailability(Map<String, Integer> productQuantities);

    /**
     * Reserves inventory for an order.
     * @param orderId the order to reserve for
     * @param productQuantities map of productId to quantity
     * @return true if all items were reserved successfully
     */
    boolean reserveInventory(String orderId, Map<String, Integer> productQuantities);

    /**
     * Releases previously reserved inventory (e.g., on order cancellation).
     */
    void releaseInventory(String orderId);
}
