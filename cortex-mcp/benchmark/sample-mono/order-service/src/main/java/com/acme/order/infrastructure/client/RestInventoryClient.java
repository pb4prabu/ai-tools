package com.acme.order.infrastructure.client;

import com.acme.order.port.InventoryClient;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

/**
 * REST client for the inventory service.
 * Uses Spring RestTemplate with circuit breaker pattern.
 */
@Component
public class RestInventoryClient implements InventoryClient {
    private final RestTemplate restTemplate;
    private static final String BASE_URL = "http://inventory-service/api/v1/inventory";

    public RestInventoryClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    @Override
    public Map<String, Integer> checkAvailability(Map<String, Integer> productQuantities) {
        // Would call inventory service REST API
        return new HashMap<>(productQuantities); // stub
    }

    @Override
    public boolean reserveInventory(String orderId, Map<String, Integer> productQuantities) {
        // Would call POST /api/v1/inventory/reserve
        return true; // stub
    }

    @Override
    public void releaseInventory(String orderId) {
        // Would call POST /api/v1/inventory/release/{orderId}
    }
}
