package com.acme.order.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;

/**
 * Spring configuration for order-service.
 * Configures REST clients, Kafka, and service properties.
 */
@Configuration
@ConfigurationProperties(prefix = "order-service")
public class OrderServiceConfig {
    private int maxItemsPerOrder = 50;
    private int paymentTimeoutSeconds = 30;
    private String defaultCurrency = "USD";

    @Bean
    public RestTemplate restTemplate() {
        return new RestTemplate();
    }

    public int getMaxItemsPerOrder() { return maxItemsPerOrder; }
    public void setMaxItemsPerOrder(int val) { this.maxItemsPerOrder = val; }
    public int getPaymentTimeoutSeconds() { return paymentTimeoutSeconds; }
    public void setPaymentTimeoutSeconds(int val) { this.paymentTimeoutSeconds = val; }
    public String getDefaultCurrency() { return defaultCurrency; }
    public void setDefaultCurrency(String val) { this.defaultCurrency = val; }
}
