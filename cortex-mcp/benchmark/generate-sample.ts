/**
 * Generates a realistic Spring Boot microservices monorepo for benchmarking.
 * Creates ~80-100 Java files across 4 services with proper structure.
 */
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

import { fileURLToPath } from 'url'
import { dirname } from 'path'
const __dirname = typeof import.meta.dirname === 'string' ? import.meta.dirname : dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, 'sample-mono')

function dir(path: string) {
  mkdirSync(join(ROOT, path), { recursive: true })
}

function file(path: string, content: string) {
  writeFileSync(join(ROOT, path), content.trimStart(), 'utf-8')
}

function javaDir(service: string, pkg: string) {
  const pkgPath = pkg.replace(/\./g, '/')
  const base = `${service}/src/main/java/${pkgPath}`
  dir(base)
  return base
}

// ─── Shared Domain Library ─────────────────────────────────────────────────

function generateSharedLib() {
  const base = javaDir('shared-lib', 'com.acme.shared')

  // --- Events ---
  const eventsDir = javaDir('shared-lib', 'com.acme.shared.events')
  file(`${eventsDir}/DomainEvent.java`, `
package com.acme.shared.events;

import java.time.Instant;
import java.util.UUID;

/**
 * Base class for all domain events in the system.
 * Events are immutable and carry a unique identifier and timestamp.
 */
public abstract class DomainEvent {
    private final UUID eventId;
    private final Instant occurredAt;
    private final String aggregateId;

    protected DomainEvent(String aggregateId) {
        this.eventId = UUID.randomUUID();
        this.occurredAt = Instant.now();
        this.aggregateId = aggregateId;
    }

    public UUID getEventId() { return eventId; }
    public Instant getOccurredAt() { return occurredAt; }
    public String getAggregateId() { return aggregateId; }
}
`)

  file(`${eventsDir}/OrderCreatedEvent.java`, `
package com.acme.shared.events;

import java.math.BigDecimal;

/**
 * Published when a new order is successfully created.
 * Consumed by payment-service and notification-service.
 */
public class OrderCreatedEvent extends DomainEvent {
    private final String customerId;
    private final BigDecimal totalAmount;
    private final String currency;

    public OrderCreatedEvent(String orderId, String customerId, BigDecimal totalAmount, String currency) {
        super(orderId);
        this.customerId = customerId;
        this.totalAmount = totalAmount;
        this.currency = currency;
    }

    public String getCustomerId() { return customerId; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public String getCurrency() { return currency; }
}
`)

  file(`${eventsDir}/PaymentCompletedEvent.java`, `
package com.acme.shared.events;

import java.math.BigDecimal;

/**
 * Published when a payment is successfully processed.
 * Consumed by order-service to update order status.
 */
public class PaymentCompletedEvent extends DomainEvent {
    private final String paymentId;
    private final BigDecimal amount;
    private final String paymentMethod;

    public PaymentCompletedEvent(String orderId, String paymentId, BigDecimal amount, String paymentMethod) {
        super(orderId);
        this.paymentId = paymentId;
        this.amount = amount;
        this.paymentMethod = paymentMethod;
    }

    public String getPaymentId() { return paymentId; }
    public BigDecimal getAmount() { return amount; }
    public String getPaymentMethod() { return paymentMethod; }
}
`)

  file(`${eventsDir}/UserRegisteredEvent.java`, `
package com.acme.shared.events;

/**
 * Published when a new user successfully registers.
 * Triggers welcome email via notification-service.
 */
public class UserRegisteredEvent extends DomainEvent {
    private final String email;
    private final String displayName;

    public UserRegisteredEvent(String userId, String email, String displayName) {
        super(userId);
        this.email = email;
        this.displayName = displayName;
    }

    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
}
`)

  // --- Common DTOs ---
  const dtoDir = javaDir('shared-lib', 'com.acme.shared.dto')
  file(`${dtoDir}/PageRequest.java`, `
package com.acme.shared.dto;

/**
 * Standard pagination request parameters.
 * Used across all REST endpoints that return paginated results.
 */
public record PageRequest(int page, int size, String sortBy, String sortDirection) {
    public PageRequest {
        if (page < 0) throw new IllegalArgumentException("Page must be >= 0");
        if (size < 1 || size > 100) throw new IllegalArgumentException("Size must be 1-100");
    }

    public static PageRequest of(int page, int size) {
        return new PageRequest(page, size, "id", "ASC");
    }

    public int offset() { return page * size; }
}
`)

  file(`${dtoDir}/ApiResponse.java`, `
package com.acme.shared.dto;

import java.time.Instant;

/**
 * Standard API response wrapper providing consistent structure.
 * All REST endpoints return responses wrapped in this envelope.
 *
 * @param <T> the type of the response payload
 */
public record ApiResponse<T>(
    boolean success,
    T data,
    String message,
    Instant timestamp
) {
    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, data, null, Instant.now());
    }

    public static <T> ApiResponse<T> error(String message) {
        return new ApiResponse<>(false, null, message, Instant.now());
    }
}
`)

  // --- Exception classes ---
  const exDir = javaDir('shared-lib', 'com.acme.shared.exception')
  file(`${exDir}/ResourceNotFoundException.java`, `
package com.acme.shared.exception;

/**
 * Thrown when a requested resource cannot be found.
 * Results in HTTP 404 response via global exception handler.
 */
public class ResourceNotFoundException extends RuntimeException {
    private final String resourceType;
    private final String resourceId;

    public ResourceNotFoundException(String resourceType, String resourceId) {
        super(String.format("%s not found with id: %s", resourceType, resourceId));
        this.resourceType = resourceType;
        this.resourceId = resourceId;
    }

    public String getResourceType() { return resourceType; }
    public String getResourceId() { return resourceId; }
}
`)

  file(`${exDir}/BusinessRuleViolationException.java`, `
package com.acme.shared.exception;

/**
 * Thrown when a business rule is violated during domain operation.
 * Results in HTTP 422 response with detailed violation info.
 */
public class BusinessRuleViolationException extends RuntimeException {
    private final String ruleCode;
    private final String entityId;

    public BusinessRuleViolationException(String ruleCode, String message, String entityId) {
        super(message);
        this.ruleCode = ruleCode;
        this.entityId = entityId;
    }

    public String getRuleCode() { return ruleCode; }
    public String getEntityId() { return entityId; }
}
`)
}

// ─── Order Service ─────────────────────────────────────────────────────────

function generateOrderService() {
  // --- Domain ---
  const domainDir = javaDir('order-service', 'com.acme.order.domain')
  file(`${domainDir}/Order.java`, `
package com.acme.order.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * Order aggregate root. Manages order lifecycle from creation through
 * fulfillment or cancellation. Enforces invariants:
 * - Order must have at least one line item
 * - Total must equal sum of line items
 * - Only PENDING orders can be cancelled
 * - Only PAID orders can be shipped
 */
public class Order {
    private final String id;
    private final String customerId;
    private final List<OrderLineItem> lineItems;
    private OrderStatus status;
    private BigDecimal totalAmount;
    private String currency;
    private String shippingAddress;
    private String trackingNumber;
    private Instant createdAt;
    private Instant updatedAt;

    public Order(String customerId, String shippingAddress, String currency) {
        this.id = UUID.randomUUID().toString();
        this.customerId = customerId;
        this.shippingAddress = shippingAddress;
        this.currency = currency;
        this.lineItems = new ArrayList<>();
        this.status = OrderStatus.PENDING;
        this.totalAmount = BigDecimal.ZERO;
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    /**
     * Adds a line item to the order and recalculates total.
     * @throws IllegalStateException if order is not in PENDING status
     */
    public void addLineItem(String productId, String productName, int quantity, BigDecimal unitPrice) {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Cannot modify order in " + status + " status");
        }
        OrderLineItem item = new OrderLineItem(productId, productName, quantity, unitPrice);
        lineItems.add(item);
        recalculateTotal();
    }

    /**
     * Removes a line item by product ID.
     * @throws IllegalStateException if order is not PENDING or would become empty
     */
    public void removeLineItem(String productId) {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Cannot modify order in " + status + " status");
        }
        boolean removed = lineItems.removeIf(item -> item.getProductId().equals(productId));
        if (!removed) throw new IllegalArgumentException("Product not in order: " + productId);
        if (lineItems.isEmpty()) throw new IllegalStateException("Order must have at least one item");
        recalculateTotal();
    }

    /**
     * Marks order as paid after successful payment processing.
     * @throws IllegalStateException if order is not in PENDING status
     */
    public void markPaid() {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only PENDING orders can be paid");
        }
        this.status = OrderStatus.PAID;
        this.updatedAt = Instant.now();
    }

    /**
     * Marks order as shipped with tracking information.
     * @throws IllegalStateException if order is not in PAID status
     */
    public void markShipped(String trackingNumber) {
        if (status != OrderStatus.PAID) {
            throw new IllegalStateException("Only PAID orders can be shipped");
        }
        this.trackingNumber = trackingNumber;
        this.status = OrderStatus.SHIPPED;
        this.updatedAt = Instant.now();
    }

    /**
     * Cancels the order. Only PENDING orders can be cancelled.
     * @throws IllegalStateException if order is not in PENDING status
     */
    public void cancel() {
        if (status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only PENDING orders can be cancelled");
        }
        this.status = OrderStatus.CANCELLED;
        this.updatedAt = Instant.now();
    }

    private void recalculateTotal() {
        this.totalAmount = lineItems.stream()
            .map(OrderLineItem::getSubtotal)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        this.updatedAt = Instant.now();
    }

    public String getId() { return id; }
    public String getCustomerId() { return customerId; }
    public OrderStatus getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public String getCurrency() { return currency; }
    public String getShippingAddress() { return shippingAddress; }
    public String getTrackingNumber() { return trackingNumber; }
    public List<OrderLineItem> getLineItems() { return Collections.unmodifiableList(lineItems); }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
`)

  file(`${domainDir}/OrderLineItem.java`, `
package com.acme.order.domain;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * Represents a single line item within an order.
 * Immutable value object — quantity and price cannot change after creation.
 */
public class OrderLineItem {
    private final String id;
    private final String productId;
    private final String productName;
    private final int quantity;
    private final BigDecimal unitPrice;

    public OrderLineItem(String productId, String productName, int quantity, BigDecimal unitPrice) {
        if (quantity < 1) throw new IllegalArgumentException("Quantity must be >= 1");
        if (unitPrice.compareTo(BigDecimal.ZERO) <= 0) throw new IllegalArgumentException("Unit price must be > 0");
        this.id = UUID.randomUUID().toString();
        this.productId = productId;
        this.productName = productName;
        this.quantity = quantity;
        this.unitPrice = unitPrice;
    }

    public BigDecimal getSubtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }

    public String getId() { return id; }
    public String getProductId() { return productId; }
    public String getProductName() { return productName; }
    public int getQuantity() { return quantity; }
    public BigDecimal getUnitPrice() { return unitPrice; }
}
`)

  file(`${domainDir}/OrderStatus.java`, `
package com.acme.order.domain;

/**
 * Order lifecycle states. Valid transitions:
 * PENDING → PAID → SHIPPED → DELIVERED
 * PENDING → CANCELLED
 * PAID → REFUNDED
 */
public enum OrderStatus {
    PENDING,
    PAID,
    SHIPPED,
    DELIVERED,
    CANCELLED,
    REFUNDED
}
`)

  // --- Ports (interfaces) ---
  const portsDir = javaDir('order-service', 'com.acme.order.port')
  file(`${portsDir}/OrderRepository.java`, `
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
`)

  file(`${portsDir}/PaymentGateway.java`, `
package com.acme.order.port;

import java.math.BigDecimal;

/**
 * Outbound port for payment processing.
 * Implemented by Stripe/PayPal adapter in infrastructure layer.
 */
public interface PaymentGateway {
    /**
     * Initiates a payment charge for the given order.
     * @param orderId unique order identifier
     * @param amount the amount to charge
     * @param currency ISO 4217 currency code
     * @param paymentMethodId tokenized payment method
     * @return payment transaction ID
     * @throws PaymentDeclinedException if the charge is declined
     */
    String charge(String orderId, BigDecimal amount, String currency, String paymentMethodId);

    /**
     * Refunds a previously completed payment.
     * @param transactionId the original payment transaction ID
     * @param amount the amount to refund (partial refunds supported)
     * @return refund transaction ID
     */
    String refund(String transactionId, BigDecimal amount);
}
`)

  file(`${portsDir}/InventoryClient.java`, `
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
`)

  file(`${portsDir}/EventPublisher.java`, `
package com.acme.order.port;

import com.acme.shared.events.DomainEvent;

/**
 * Outbound port for publishing domain events.
 * Implemented by Kafka/RabbitMQ adapter.
 */
public interface EventPublisher {
    void publish(DomainEvent event);
    void publishAsync(DomainEvent event);
}
`)

  // --- Application Services ---
  const appDir = javaDir('order-service', 'com.acme.order.application')
  file(`${appDir}/CreateOrderUseCase.java`, `
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
`)

  file(`${appDir}/CreateOrderCommand.java`, `
package com.acme.order.application;

import java.math.BigDecimal;
import java.util.List;

/**
 * Command object for creating a new order.
 * Validated at the controller layer before reaching the use case.
 */
public record CreateOrderCommand(
    String customerId,
    String shippingAddress,
    String currency,
    List<Item> items
) {
    public record Item(
        String productId,
        String productName,
        int quantity,
        BigDecimal unitPrice
    ) {}
}
`)

  file(`${appDir}/CancelOrderUseCase.java`, `
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
`)

  file(`${appDir}/GetOrderQueryService.java`, `
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
`)

  // --- REST Controller ---
  const webDir = javaDir('order-service', 'com.acme.order.web')
  file(`${webDir}/OrderController.java`, `
package com.acme.order.web;

import com.acme.order.application.CancelOrderUseCase;
import com.acme.order.application.CreateOrderCommand;
import com.acme.order.application.CreateOrderUseCase;
import com.acme.order.application.GetOrderQueryService;
import com.acme.order.domain.Order;
import com.acme.order.domain.OrderStatus;
import com.acme.shared.dto.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * REST API for order management.
 * Handles CRUD operations and order lifecycle transitions.
 *
 * Base path: /api/v1/orders
 */
@RestController
@RequestMapping("/api/v1/orders")
public class OrderController {
    private final CreateOrderUseCase createOrderUseCase;
    private final CancelOrderUseCase cancelOrderUseCase;
    private final GetOrderQueryService queryService;

    public OrderController(CreateOrderUseCase createOrderUseCase,
                           CancelOrderUseCase cancelOrderUseCase,
                           GetOrderQueryService queryService) {
        this.createOrderUseCase = createOrderUseCase;
        this.cancelOrderUseCase = cancelOrderUseCase;
        this.queryService = queryService;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<Order> createOrder(@Valid @RequestBody CreateOrderRequest request) {
        CreateOrderCommand command = request.toCommand();
        Order order = createOrderUseCase.execute(command);
        return ApiResponse.ok(order);
    }

    @GetMapping("/{orderId}")
    public ApiResponse<Order> getOrder(@PathVariable String orderId) {
        return ApiResponse.ok(queryService.getById(orderId));
    }

    @GetMapping
    public ApiResponse<List<Order>> getOrders(
            @RequestParam String customerId,
            @RequestParam(required = false) OrderStatus status) {
        List<Order> orders = (status != null)
            ? queryService.getByCustomerAndStatus(customerId, status)
            : queryService.getByCustomer(customerId);
        return ApiResponse.ok(orders);
    }

    @PostMapping("/{orderId}/cancel")
    public ApiResponse<Order> cancelOrder(@PathVariable String orderId) {
        return ApiResponse.ok(cancelOrderUseCase.execute(orderId));
    }

    @GetMapping("/count")
    public ApiResponse<Long> countByStatus(@RequestParam OrderStatus status) {
        return ApiResponse.ok(queryService.countByStatus(status));
    }
}
`)

  file(`${webDir}/CreateOrderRequest.java`, `
package com.acme.order.web;

import com.acme.order.application.CreateOrderCommand;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;

import java.math.BigDecimal;
import java.util.List;

/**
 * REST request body for creating an order.
 * Validates input before converting to domain command.
 */
public record CreateOrderRequest(
    @NotBlank String customerId,
    @NotBlank String shippingAddress,
    @NotBlank String currency,
    @NotEmpty List<LineItemRequest> items
) {
    public record LineItemRequest(
        @NotBlank String productId,
        @NotBlank String productName,
        @Positive int quantity,
        @Positive BigDecimal unitPrice
    ) {}

    public CreateOrderCommand toCommand() {
        return new CreateOrderCommand(
            customerId, shippingAddress, currency,
            items.stream().map(i -> new CreateOrderCommand.Item(
                i.productId(), i.productName(), i.quantity(), i.unitPrice()
            )).toList()
        );
    }
}
`)

  file(`${webDir}/GlobalExceptionHandler.java`, `
package com.acme.order.web;

import com.acme.shared.dto.ApiResponse;
import com.acme.shared.exception.BusinessRuleViolationException;
import com.acme.shared.exception.ResourceNotFoundException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Global exception handler for the order service.
 * Maps domain exceptions to appropriate HTTP responses.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResourceNotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ApiResponse<Void> handleNotFound(ResourceNotFoundException ex) {
        return ApiResponse.error(ex.getMessage());
    }

    @ExceptionHandler(BusinessRuleViolationException.class)
    @ResponseStatus(HttpStatus.UNPROCESSABLE_ENTITY)
    public ApiResponse<Void> handleBusinessRule(BusinessRuleViolationException ex) {
        return ApiResponse.error(ex.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiResponse<Void> handleBadRequest(IllegalArgumentException ex) {
        return ApiResponse.error(ex.getMessage());
    }
}
`)

  // --- Infrastructure ---
  const infraDir = javaDir('order-service', 'com.acme.order.infrastructure.persistence')
  file(`${infraDir}/JpaOrderRepository.java`, `
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
`)

  const kafkaDir = javaDir('order-service', 'com.acme.order.infrastructure.messaging')
  file(`${kafkaDir}/KafkaEventPublisher.java`, `
package com.acme.order.infrastructure.messaging;

import com.acme.order.port.EventPublisher;
import com.acme.shared.events.DomainEvent;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

/**
 * Kafka-based implementation of EventPublisher.
 * Publishes domain events to topic derived from event class name.
 */
@Component
public class KafkaEventPublisher implements EventPublisher {
    private final KafkaTemplate<String, DomainEvent> kafkaTemplate;

    public KafkaEventPublisher(KafkaTemplate<String, DomainEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @Override
    public void publish(DomainEvent event) {
        String topic = event.getClass().getSimpleName();
        kafkaTemplate.send(topic, event.getAggregateId(), event);
    }

    @Override
    public void publishAsync(DomainEvent event) {
        String topic = event.getClass().getSimpleName();
        kafkaTemplate.send(topic, event.getAggregateId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    // Log and potentially retry
                    System.err.println("Failed to publish event: " + ex.getMessage());
                }
            });
    }
}
`)

  const restDir = javaDir('order-service', 'com.acme.order.infrastructure.client')
  file(`${restDir}/RestInventoryClient.java`, `
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
`)

  // --- Config ---
  const configDir = javaDir('order-service', 'com.acme.order.config')
  file(`${configDir}/OrderServiceConfig.java`, `
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
`)
}

// ─── User Service ──────────────────────────────────────────────────────────

function generateUserService() {
  const domainDir = javaDir('user-service', 'com.acme.user.domain')
  file(`${domainDir}/User.java`, `
package com.acme.user.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * User aggregate root. Manages user profile and authentication state.
 * Enforces invariants:
 * - Email must be unique (enforced at repository level)
 * - Password must be hashed before storage
 * - Deactivated users cannot log in
 */
public class User {
    private final String id;
    private String email;
    private String passwordHash;
    private String displayName;
    private String avatarUrl;
    private UserRole role;
    private boolean active;
    private Instant createdAt;
    private Instant lastLoginAt;

    public User(String email, String passwordHash, String displayName) {
        this.id = UUID.randomUUID().toString();
        this.email = email;
        this.passwordHash = passwordHash;
        this.displayName = displayName;
        this.role = UserRole.CUSTOMER;
        this.active = true;
        this.createdAt = Instant.now();
    }

    public void updateProfile(String displayName, String avatarUrl) {
        this.displayName = displayName;
        this.avatarUrl = avatarUrl;
    }

    public void changePassword(String newPasswordHash) {
        this.passwordHash = newPasswordHash;
    }

    public void deactivate() {
        this.active = false;
    }

    public void recordLogin() {
        this.lastLoginAt = Instant.now();
    }

    public void promoteToAdmin() {
        this.role = UserRole.ADMIN;
    }

    public String getId() { return id; }
    public String getEmail() { return email; }
    public String getPasswordHash() { return passwordHash; }
    public String getDisplayName() { return displayName; }
    public String getAvatarUrl() { return avatarUrl; }
    public UserRole getRole() { return role; }
    public boolean isActive() { return active; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getLastLoginAt() { return lastLoginAt; }
}
`)

  file(`${domainDir}/UserRole.java`, `
package com.acme.user.domain;

/** User authorization roles with hierarchical permissions. */
public enum UserRole {
    CUSTOMER,
    SUPPORT,
    ADMIN,
    SUPER_ADMIN
}
`)

  file(`${domainDir}/Address.java`, `
package com.acme.user.domain;

/**
 * Value object representing a shipping/billing address.
 * Immutable — create a new instance to change.
 */
public record Address(
    String street,
    String city,
    String state,
    String postalCode,
    String country
) {
    public String formatted() {
        return String.join(", ", street, city, state, postalCode, country);
    }
}
`)

  // --- Ports ---
  const portDir = javaDir('user-service', 'com.acme.user.port')
  file(`${portDir}/UserRepository.java`, `
package com.acme.user.port;

import com.acme.user.domain.User;
import java.util.List;
import java.util.Optional;

/**
 * Outbound port for user persistence.
 */
public interface UserRepository {
    User save(User user);
    Optional<User> findById(String id);
    Optional<User> findByEmail(String email);
    List<User> findAll(int offset, int limit);
    boolean existsByEmail(String email);
    void deleteById(String id);
}
`)

  file(`${portDir}/PasswordEncoder.java`, `
package com.acme.user.port;

/**
 * Outbound port for password hashing.
 * Implemented by BCrypt adapter.
 */
public interface PasswordEncoder {
    String encode(String rawPassword);
    boolean matches(String rawPassword, String encodedPassword);
}
`)

  file(`${portDir}/TokenProvider.java`, `
package com.acme.user.port;

import com.acme.user.domain.User;

/**
 * Outbound port for JWT token generation and validation.
 */
public interface TokenProvider {
    String generateAccessToken(User user);
    String generateRefreshToken(User user);
    String validateAndGetUserId(String token);
    boolean isTokenExpired(String token);
}
`)

  // --- Application ---
  const appDir = javaDir('user-service', 'com.acme.user.application')
  file(`${appDir}/RegisterUserUseCase.java`, `
package com.acme.user.application;

import com.acme.shared.events.UserRegisteredEvent;
import com.acme.shared.exception.BusinessRuleViolationException;
import com.acme.user.domain.User;
import com.acme.user.port.PasswordEncoder;
import com.acme.user.port.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Handles new user registration:
 * 1. Validates email uniqueness
 * 2. Hashes password
 * 3. Creates user aggregate
 * 4. Publishes UserRegisteredEvent
 */
@Service
public class RegisterUserUseCase {
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public RegisterUserUseCase(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Transactional
    public User execute(String email, String password, String displayName) {
        if (userRepository.existsByEmail(email)) {
            throw new BusinessRuleViolationException(
                "DUPLICATE_EMAIL", "Email already registered: " + email, email);
        }

        String hash = passwordEncoder.encode(password);
        User user = new User(email, hash, displayName);
        return userRepository.save(user);
    }
}
`)

  file(`${appDir}/AuthenticateUserUseCase.java`, `
package com.acme.user.application;

import com.acme.shared.exception.BusinessRuleViolationException;
import com.acme.user.domain.User;
import com.acme.user.port.PasswordEncoder;
import com.acme.user.port.TokenProvider;
import com.acme.user.port.UserRepository;
import org.springframework.stereotype.Service;

/**
 * Handles user authentication:
 * 1. Finds user by email
 * 2. Verifies password
 * 3. Checks account is active
 * 4. Generates JWT tokens
 * 5. Records login timestamp
 */
@Service
public class AuthenticateUserUseCase {
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final TokenProvider tokenProvider;

    public AuthenticateUserUseCase(UserRepository userRepository,
                                   PasswordEncoder passwordEncoder,
                                   TokenProvider tokenProvider) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.tokenProvider = tokenProvider;
    }

    public AuthResult execute(String email, String password) {
        User user = userRepository.findByEmail(email)
            .orElseThrow(() -> new BusinessRuleViolationException(
                "INVALID_CREDENTIALS", "Invalid email or password", email));

        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            throw new BusinessRuleViolationException(
                "INVALID_CREDENTIALS", "Invalid email or password", email);
        }

        if (!user.isActive()) {
            throw new BusinessRuleViolationException(
                "ACCOUNT_DEACTIVATED", "Account has been deactivated", user.getId());
        }

        user.recordLogin();
        userRepository.save(user);

        return new AuthResult(
            tokenProvider.generateAccessToken(user),
            tokenProvider.generateRefreshToken(user),
            user.getId(),
            user.getDisplayName()
        );
    }

    public record AuthResult(String accessToken, String refreshToken, String userId, String displayName) {}
}
`)

  // --- Web ---
  const webDir = javaDir('user-service', 'com.acme.user.web')
  file(`${webDir}/UserController.java`, `
package com.acme.user.web;

import com.acme.shared.dto.ApiResponse;
import com.acme.user.application.AuthenticateUserUseCase;
import com.acme.user.application.RegisterUserUseCase;
import com.acme.user.domain.User;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/**
 * REST API for user management and authentication.
 * Base path: /api/v1/users
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {
    private final RegisterUserUseCase registerUseCase;
    private final AuthenticateUserUseCase authUseCase;

    public UserController(RegisterUserUseCase registerUseCase,
                          AuthenticateUserUseCase authUseCase) {
        this.registerUseCase = registerUseCase;
        this.authUseCase = authUseCase;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<UserResponse> register(@Valid @RequestBody RegisterRequest request) {
        User user = registerUseCase.execute(request.email(), request.password(), request.displayName());
        return ApiResponse.ok(UserResponse.from(user));
    }

    @PostMapping("/login")
    public ApiResponse<AuthenticateUserUseCase.AuthResult> login(@Valid @RequestBody LoginRequest request) {
        return ApiResponse.ok(authUseCase.execute(request.email(), request.password()));
    }
}
`)

  file(`${webDir}/RegisterRequest.java`, `
package com.acme.user.web;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record RegisterRequest(
    @NotBlank @Email String email,
    @NotBlank @Size(min = 8, max = 128) String password,
    @NotBlank String displayName
) {}
`)

  file(`${webDir}/LoginRequest.java`, `
package com.acme.user.web;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

public record LoginRequest(
    @NotBlank @Email String email,
    @NotBlank String password
) {}
`)

  file(`${webDir}/UserResponse.java`, `
package com.acme.user.web;

import com.acme.user.domain.User;
import com.acme.user.domain.UserRole;

/** DTO for user data returned to clients. Excludes sensitive fields. */
public record UserResponse(String id, String email, String displayName, String avatarUrl, UserRole role) {
    public static UserResponse from(User user) {
        return new UserResponse(user.getId(), user.getEmail(), user.getDisplayName(), user.getAvatarUrl(), user.getRole());
    }
}
`)

  // --- Infrastructure ---
  const infraDir = javaDir('user-service', 'com.acme.user.infrastructure')
  file(`${infraDir}/BCryptPasswordEncoder.java`, `
package com.acme.user.infrastructure;

import com.acme.user.port.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * BCrypt-based password encoder implementation.
 * Uses adaptive cost factor for future-proofing.
 */
@Component
public class BCryptPasswordEncoder implements PasswordEncoder {
    private static final int COST_FACTOR = 12;

    @Override
    public String encode(String rawPassword) {
        // In production: BCrypt.hashpw(rawPassword, BCrypt.gensalt(COST_FACTOR))
        return "bcrypt:" + rawPassword.hashCode();
    }

    @Override
    public boolean matches(String rawPassword, String encodedPassword) {
        return encodedPassword.equals(encode(rawPassword));
    }
}
`)

  file(`${infraDir}/JwtTokenProvider.java`, `
package com.acme.user.infrastructure;

import com.acme.user.domain.User;
import com.acme.user.port.TokenProvider;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * JWT-based token provider.
 * Access tokens expire in 15 minutes, refresh tokens in 7 days.
 */
@Component
public class JwtTokenProvider implements TokenProvider {
    private static final long ACCESS_TOKEN_MINUTES = 15;
    private static final long REFRESH_TOKEN_DAYS = 7;

    @Override
    public String generateAccessToken(User user) {
        return "jwt-access:" + user.getId() + ":" + UUID.randomUUID();
    }

    @Override
    public String generateRefreshToken(User user) {
        return "jwt-refresh:" + user.getId() + ":" + UUID.randomUUID();
    }

    @Override
    public String validateAndGetUserId(String token) {
        String[] parts = token.split(":");
        return parts.length >= 2 ? parts[1] : null;
    }

    @Override
    public boolean isTokenExpired(String token) {
        return false; // stub
    }
}
`)
}

// ─── Payment Service ───────────────────────────────────────────────────────

function generatePaymentService() {
  const domainDir = javaDir('payment-service', 'com.acme.payment.domain')
  file(`${domainDir}/Payment.java`, `
package com.acme.payment.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Payment aggregate root. Represents a payment transaction.
 * Tracks the lifecycle from initiation through completion or failure.
 *
 * Invariants:
 * - Amount must be positive
 * - Only PENDING payments can be completed or failed
 * - Completed payments can be refunded (full or partial)
 */
public class Payment {
    private final String id;
    private final String orderId;
    private final String customerId;
    private final BigDecimal amount;
    private final String currency;
    private PaymentStatus status;
    private String paymentMethod;
    private String gatewayTransactionId;
    private String failureReason;
    private BigDecimal refundedAmount;
    private Instant createdAt;
    private Instant completedAt;

    public Payment(String orderId, String customerId, BigDecimal amount, String currency, String paymentMethod) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new IllegalArgumentException("Payment amount must be positive");
        }
        this.id = UUID.randomUUID().toString();
        this.orderId = orderId;
        this.customerId = customerId;
        this.amount = amount;
        this.currency = currency;
        this.paymentMethod = paymentMethod;
        this.status = PaymentStatus.PENDING;
        this.refundedAmount = BigDecimal.ZERO;
        this.createdAt = Instant.now();
    }

    /**
     * Marks payment as successfully completed.
     * @param gatewayTransactionId the transaction ID from payment gateway
     */
    public void complete(String gatewayTransactionId) {
        if (status != PaymentStatus.PENDING) {
            throw new IllegalStateException("Only PENDING payments can be completed");
        }
        this.gatewayTransactionId = gatewayTransactionId;
        this.status = PaymentStatus.COMPLETED;
        this.completedAt = Instant.now();
    }

    /**
     * Marks payment as failed.
     * @param reason description of why the payment failed
     */
    public void fail(String reason) {
        if (status != PaymentStatus.PENDING) {
            throw new IllegalStateException("Only PENDING payments can fail");
        }
        this.failureReason = reason;
        this.status = PaymentStatus.FAILED;
    }

    /**
     * Processes a refund for the specified amount.
     * @param refundAmount amount to refund (must not exceed remaining refundable amount)
     */
    public void refund(BigDecimal refundAmount) {
        if (status != PaymentStatus.COMPLETED && status != PaymentStatus.PARTIALLY_REFUNDED) {
            throw new IllegalStateException("Can only refund completed payments");
        }
        BigDecimal maxRefundable = amount.subtract(refundedAmount);
        if (refundAmount.compareTo(maxRefundable) > 0) {
            throw new IllegalArgumentException("Refund amount exceeds remaining: " + maxRefundable);
        }
        this.refundedAmount = this.refundedAmount.add(refundAmount);
        this.status = this.refundedAmount.compareTo(amount) >= 0
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;
    }

    public String getId() { return id; }
    public String getOrderId() { return orderId; }
    public String getCustomerId() { return customerId; }
    public BigDecimal getAmount() { return amount; }
    public String getCurrency() { return currency; }
    public PaymentStatus getStatus() { return status; }
    public String getPaymentMethod() { return paymentMethod; }
    public String getGatewayTransactionId() { return gatewayTransactionId; }
    public String getFailureReason() { return failureReason; }
    public BigDecimal getRefundedAmount() { return refundedAmount; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getCompletedAt() { return completedAt; }
}
`)

  file(`${domainDir}/PaymentStatus.java`, `
package com.acme.payment.domain;

/** Payment lifecycle states. */
public enum PaymentStatus {
    PENDING,
    COMPLETED,
    FAILED,
    PARTIALLY_REFUNDED,
    REFUNDED
}
`)

  file(`${domainDir}/PaymentMethod.java`, `
package com.acme.payment.domain;

/**
 * Supported payment methods with their processing characteristics.
 */
public enum PaymentMethod {
    CREDIT_CARD("Credit Card", true, 2.9),
    DEBIT_CARD("Debit Card", true, 1.5),
    PAYPAL("PayPal", true, 3.4),
    BANK_TRANSFER("Bank Transfer", false, 0.5),
    CRYPTO("Cryptocurrency", false, 1.0);

    private final String displayName;
    private final boolean supportsRefund;
    private final double feePercent;

    PaymentMethod(String displayName, boolean supportsRefund, double feePercent) {
        this.displayName = displayName;
        this.supportsRefund = supportsRefund;
        this.feePercent = feePercent;
    }

    public String getDisplayName() { return displayName; }
    public boolean isSupportsRefund() { return supportsRefund; }
    public double getFeePercent() { return feePercent; }
}
`)

  // --- Ports ---
  const portDir = javaDir('payment-service', 'com.acme.payment.port')
  file(`${portDir}/PaymentRepository.java`, `
package com.acme.payment.port;

import com.acme.payment.domain.Payment;
import com.acme.payment.domain.PaymentStatus;
import java.util.List;
import java.util.Optional;

/** Outbound port for payment persistence. */
public interface PaymentRepository {
    Payment save(Payment payment);
    Optional<Payment> findById(String id);
    Optional<Payment> findByOrderId(String orderId);
    List<Payment> findByCustomerId(String customerId);
    List<Payment> findByStatus(PaymentStatus status);
}
`)

  file(`${portDir}/StripeGateway.java`, `
package com.acme.payment.port;

import java.math.BigDecimal;

/**
 * Outbound port for Stripe payment processing.
 */
public interface StripeGateway {
    ChargeResult charge(String paymentMethodId, BigDecimal amount, String currency, String idempotencyKey);
    RefundResult refund(String chargeId, BigDecimal amount);

    record ChargeResult(String chargeId, boolean success, String failureMessage) {}
    record RefundResult(String refundId, boolean success) {}
}
`)

  // --- Application ---
  const appDir = javaDir('payment-service', 'com.acme.payment.application')
  file(`${appDir}/ProcessPaymentUseCase.java`, `
package com.acme.payment.application;

import com.acme.payment.domain.Payment;
import com.acme.payment.port.PaymentRepository;
import com.acme.payment.port.StripeGateway;
import com.acme.shared.events.PaymentCompletedEvent;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

/**
 * Processes payments through the payment gateway:
 * 1. Creates payment record in PENDING state
 * 2. Calls Stripe to charge the payment method
 * 3. Updates payment status based on gateway response
 * 4. Publishes PaymentCompletedEvent on success
 */
@Service
public class ProcessPaymentUseCase {
    private final PaymentRepository paymentRepository;
    private final StripeGateway stripeGateway;

    public ProcessPaymentUseCase(PaymentRepository paymentRepository, StripeGateway stripeGateway) {
        this.paymentRepository = paymentRepository;
        this.stripeGateway = stripeGateway;
    }

    @Transactional
    public Payment execute(String orderId, String customerId, BigDecimal amount,
                           String currency, String paymentMethodId) {
        Payment payment = new Payment(orderId, customerId, amount, currency, paymentMethodId);
        payment = paymentRepository.save(payment);

        StripeGateway.ChargeResult result = stripeGateway.charge(
            paymentMethodId, amount, currency, payment.getId());

        if (result.success()) {
            payment.complete(result.chargeId());
        } else {
            payment.fail(result.failureMessage());
        }

        return paymentRepository.save(payment);
    }
}
`)

  file(`${appDir}/RefundPaymentUseCase.java`, `
package com.acme.payment.application;

import com.acme.payment.domain.Payment;
import com.acme.payment.port.PaymentRepository;
import com.acme.payment.port.StripeGateway;
import com.acme.shared.exception.ResourceNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

/**
 * Handles payment refunds (full or partial):
 * 1. Validates payment exists and is refundable
 * 2. Calls Stripe to process refund
 * 3. Updates payment aggregate with refund details
 */
@Service
public class RefundPaymentUseCase {
    private final PaymentRepository paymentRepository;
    private final StripeGateway stripeGateway;

    public RefundPaymentUseCase(PaymentRepository paymentRepository, StripeGateway stripeGateway) {
        this.paymentRepository = paymentRepository;
        this.stripeGateway = stripeGateway;
    }

    @Transactional
    public Payment execute(String paymentId, BigDecimal refundAmount) {
        Payment payment = paymentRepository.findById(paymentId)
            .orElseThrow(() -> new ResourceNotFoundException("Payment", paymentId));

        StripeGateway.RefundResult result = stripeGateway.refund(
            payment.getGatewayTransactionId(), refundAmount);

        if (result.success()) {
            payment.refund(refundAmount);
        }

        return paymentRepository.save(payment);
    }
}
`)

  // --- Web ---
  const webDir = javaDir('payment-service', 'com.acme.payment.web')
  file(`${webDir}/PaymentController.java`, `
package com.acme.payment.web;

import com.acme.payment.application.ProcessPaymentUseCase;
import com.acme.payment.application.RefundPaymentUseCase;
import com.acme.payment.domain.Payment;
import com.acme.shared.dto.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;

/**
 * REST API for payment operations.
 * Base path: /api/v1/payments
 */
@RestController
@RequestMapping("/api/v1/payments")
public class PaymentController {
    private final ProcessPaymentUseCase processPayment;
    private final RefundPaymentUseCase refundPayment;

    public PaymentController(ProcessPaymentUseCase processPayment, RefundPaymentUseCase refundPayment) {
        this.processPayment = processPayment;
        this.refundPayment = refundPayment;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<Payment> processPayment(@Valid @RequestBody PaymentRequest request) {
        Payment payment = processPayment.execute(
            request.orderId(), request.customerId(), request.amount(),
            request.currency(), request.paymentMethodId());
        return ApiResponse.ok(payment);
    }

    @PostMapping("/{paymentId}/refund")
    public ApiResponse<Payment> refundPayment(
            @PathVariable String paymentId,
            @RequestBody RefundRequest request) {
        Payment payment = refundPayment.execute(paymentId, request.amount());
        return ApiResponse.ok(payment);
    }
}
`)

  file(`${webDir}/PaymentRequest.java`, `
package com.acme.payment.web;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;

public record PaymentRequest(
    @NotBlank String orderId,
    @NotBlank String customerId,
    @Positive BigDecimal amount,
    @NotBlank String currency,
    @NotBlank String paymentMethodId
) {}
`)

  file(`${webDir}/RefundRequest.java`, `
package com.acme.payment.web;

import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;

public record RefundRequest(@Positive BigDecimal amount) {}
`)

  // --- Kafka listener ---
  const listenerDir = javaDir('payment-service', 'com.acme.payment.infrastructure.listener')
  file(`${listenerDir}/OrderEventListener.java`, `
package com.acme.payment.infrastructure.listener;

import com.acme.payment.application.ProcessPaymentUseCase;
import com.acme.shared.events.OrderCreatedEvent;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Listens for order events and triggers payment processing.
 * Auto-processes payment when a new order is created.
 */
@Component
public class OrderEventListener {
    private final ProcessPaymentUseCase processPayment;

    public OrderEventListener(ProcessPaymentUseCase processPayment) {
        this.processPayment = processPayment;
    }

    @KafkaListener(topics = "OrderCreatedEvent", groupId = "payment-service")
    public void onOrderCreated(OrderCreatedEvent event) {
        processPayment.execute(
            event.getAggregateId(),
            event.getCustomerId(),
            event.getTotalAmount(),
            event.getCurrency(),
            "default-payment-method"
        );
    }
}
`)
}

// ─── Notification Service ──────────────────────────────────────────────────

function generateNotificationService() {
  const domainDir = javaDir('notification-service', 'com.acme.notification.domain')
  file(`${domainDir}/Notification.java`, `
package com.acme.notification.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * Notification entity tracking all outbound communications.
 * Supports multiple channels: email, SMS, push notification.
 */
public class Notification {
    private final String id;
    private final String recipientId;
    private final String recipientEmail;
    private final NotificationType type;
    private final NotificationChannel channel;
    private final String subject;
    private final String body;
    private NotificationStatus status;
    private String failureReason;
    private int retryCount;
    private Instant createdAt;
    private Instant sentAt;

    public Notification(String recipientId, String recipientEmail,
                        NotificationType type, NotificationChannel channel,
                        String subject, String body) {
        this.id = UUID.randomUUID().toString();
        this.recipientId = recipientId;
        this.recipientEmail = recipientEmail;
        this.type = type;
        this.channel = channel;
        this.subject = subject;
        this.body = body;
        this.status = NotificationStatus.PENDING;
        this.retryCount = 0;
        this.createdAt = Instant.now();
    }

    public void markSent() {
        this.status = NotificationStatus.SENT;
        this.sentAt = Instant.now();
    }

    public void markFailed(String reason) {
        this.failureReason = reason;
        this.retryCount++;
        this.status = retryCount >= 3 ? NotificationStatus.PERMANENTLY_FAILED : NotificationStatus.FAILED;
    }

    public boolean canRetry() {
        return status == NotificationStatus.FAILED && retryCount < 3;
    }

    public String getId() { return id; }
    public String getRecipientId() { return recipientId; }
    public String getRecipientEmail() { return recipientEmail; }
    public NotificationType getType() { return type; }
    public NotificationChannel getChannel() { return channel; }
    public String getSubject() { return subject; }
    public String getBody() { return body; }
    public NotificationStatus getStatus() { return status; }
    public int getRetryCount() { return retryCount; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getSentAt() { return sentAt; }
}
`)

  file(`${domainDir}/NotificationType.java`, `
package com.acme.notification.domain;

/** Types of notifications sent by the system. */
public enum NotificationType {
    WELCOME_EMAIL,
    ORDER_CONFIRMATION,
    PAYMENT_RECEIPT,
    SHIPPING_UPDATE,
    PASSWORD_RESET,
    ACCOUNT_DEACTIVATED,
    PROMOTIONAL
}
`)

  file(`${domainDir}/NotificationChannel.java`, `
package com.acme.notification.domain;

/** Available notification delivery channels. */
public enum NotificationChannel {
    EMAIL,
    SMS,
    PUSH
}
`)

  file(`${domainDir}/NotificationStatus.java`, `
package com.acme.notification.domain;

/** Notification delivery states. */
public enum NotificationStatus {
    PENDING,
    SENT,
    FAILED,
    PERMANENTLY_FAILED
}
`)

  file(`${domainDir}/NotificationTemplate.java`, `
package com.acme.notification.domain;

import java.util.Map;

/**
 * Template for generating notification content.
 * Supports variable substitution using {{variable}} syntax.
 */
public class NotificationTemplate {
    private final NotificationType type;
    private final String subjectTemplate;
    private final String bodyTemplate;

    public NotificationTemplate(NotificationType type, String subjectTemplate, String bodyTemplate) {
        this.type = type;
        this.subjectTemplate = subjectTemplate;
        this.bodyTemplate = bodyTemplate;
    }

    /**
     * Renders the template with the given variables.
     * Replaces all {{key}} placeholders with corresponding values.
     */
    public RenderedContent render(Map<String, String> variables) {
        String subject = replaceVars(subjectTemplate, variables);
        String body = replaceVars(bodyTemplate, variables);
        return new RenderedContent(subject, body);
    }

    private String replaceVars(String template, Map<String, String> variables) {
        String result = template;
        for (var entry : variables.entrySet()) {
            result = result.replace("{{" + entry.getKey() + "}}", entry.getValue());
        }
        return result;
    }

    public record RenderedContent(String subject, String body) {}
}
`)

  // --- Ports ---
  const portDir = javaDir('notification-service', 'com.acme.notification.port')
  file(`${portDir}/NotificationRepository.java`, `
package com.acme.notification.port;

import com.acme.notification.domain.Notification;
import com.acme.notification.domain.NotificationStatus;
import java.util.List;
import java.util.Optional;

public interface NotificationRepository {
    Notification save(Notification notification);
    Optional<Notification> findById(String id);
    List<Notification> findByRecipientId(String recipientId);
    List<Notification> findByStatus(NotificationStatus status);
    List<Notification> findRetryable();
}
`)

  file(`${portDir}/EmailSender.java`, `
package com.acme.notification.port;

/**
 * Outbound port for sending emails.
 * Implemented by SendGrid/SES adapter.
 */
public interface EmailSender {
    /**
     * Sends an email to the specified recipient.
     * @throws EmailDeliveryException if sending fails
     */
    void send(String to, String subject, String htmlBody);

    /** Sends email with attachments. */
    void sendWithAttachment(String to, String subject, String htmlBody, byte[] attachment, String filename);
}
`)

  // --- Application ---
  const appDir = javaDir('notification-service', 'com.acme.notification.application')
  file(`${appDir}/SendNotificationUseCase.java`, `
package com.acme.notification.application;

import com.acme.notification.domain.Notification;
import com.acme.notification.domain.NotificationChannel;
import com.acme.notification.port.EmailSender;
import com.acme.notification.port.NotificationRepository;
import org.springframework.stereotype.Service;

/**
 * Sends notifications through the appropriate channel.
 * Handles failures and retry tracking.
 */
@Service
public class SendNotificationUseCase {
    private final NotificationRepository notificationRepository;
    private final EmailSender emailSender;

    public SendNotificationUseCase(NotificationRepository notificationRepository, EmailSender emailSender) {
        this.notificationRepository = notificationRepository;
        this.emailSender = emailSender;
    }

    public Notification execute(Notification notification) {
        try {
            if (notification.getChannel() == NotificationChannel.EMAIL) {
                emailSender.send(notification.getRecipientEmail(),
                    notification.getSubject(), notification.getBody());
            }
            notification.markSent();
        } catch (Exception e) {
            notification.markFailed(e.getMessage());
        }
        return notificationRepository.save(notification);
    }
}
`)

  file(`${appDir}/RetryFailedNotificationsJob.java`, `
package com.acme.notification.application;

import com.acme.notification.domain.Notification;
import com.acme.notification.port.NotificationRepository;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Scheduled job that retries failed notifications.
 * Runs every 5 minutes, picks up notifications with retryCount < 3.
 */
@Component
public class RetryFailedNotificationsJob {
    private final NotificationRepository repository;
    private final SendNotificationUseCase sendNotification;

    public RetryFailedNotificationsJob(NotificationRepository repository,
                                       SendNotificationUseCase sendNotification) {
        this.repository = repository;
        this.sendNotification = sendNotification;
    }

    @Scheduled(fixedRate = 300000) // 5 minutes
    public void retryFailed() {
        List<Notification> retryable = repository.findRetryable();
        for (Notification notification : retryable) {
            if (notification.canRetry()) {
                sendNotification.execute(notification);
            }
        }
    }
}
`)

  // --- Web ---
  const webDir = javaDir('notification-service', 'com.acme.notification.web')
  file(`${webDir}/NotificationController.java`, `
package com.acme.notification.web;

import com.acme.notification.domain.Notification;
import com.acme.notification.port.NotificationRepository;
import com.acme.shared.dto.ApiResponse;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * REST API for notification management.
 * Base path: /api/v1/notifications
 */
@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {
    private final NotificationRepository repository;

    public NotificationController(NotificationRepository repository) {
        this.repository = repository;
    }

    @GetMapping("/user/{userId}")
    public ApiResponse<List<Notification>> getByUser(@PathVariable String userId) {
        return ApiResponse.ok(repository.findByRecipientId(userId));
    }
}
`)

  // --- Kafka listener ---
  const listenerDir = javaDir('notification-service', 'com.acme.notification.infrastructure.listener')
  file(`${listenerDir}/EventNotificationListener.java`, `
package com.acme.notification.infrastructure.listener;

import com.acme.notification.application.SendNotificationUseCase;
import com.acme.notification.domain.Notification;
import com.acme.notification.domain.NotificationChannel;
import com.acme.notification.domain.NotificationType;
import com.acme.shared.events.OrderCreatedEvent;
import com.acme.shared.events.PaymentCompletedEvent;
import com.acme.shared.events.UserRegisteredEvent;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Listens for domain events and sends appropriate notifications.
 * Handles welcome emails, order confirmations, and payment receipts.
 */
@Component
public class EventNotificationListener {
    private final SendNotificationUseCase sendNotification;

    public EventNotificationListener(SendNotificationUseCase sendNotification) {
        this.sendNotification = sendNotification;
    }

    @KafkaListener(topics = "UserRegisteredEvent", groupId = "notification-service")
    public void onUserRegistered(UserRegisteredEvent event) {
        Notification notification = new Notification(
            event.getAggregateId(), event.getEmail(),
            NotificationType.WELCOME_EMAIL, NotificationChannel.EMAIL,
            "Welcome to Acme Store!",
            "Hello " + event.getDisplayName() + ", welcome aboard!"
        );
        sendNotification.execute(notification);
    }

    @KafkaListener(topics = "OrderCreatedEvent", groupId = "notification-service")
    public void onOrderCreated(OrderCreatedEvent event) {
        Notification notification = new Notification(
            event.getCustomerId(), null,
            NotificationType.ORDER_CONFIRMATION, NotificationChannel.EMAIL,
            "Order Confirmed: " + event.getAggregateId(),
            "Your order of " + event.getTotalAmount() + " " + event.getCurrency() + " has been placed."
        );
        sendNotification.execute(notification);
    }

    @KafkaListener(topics = "PaymentCompletedEvent", groupId = "notification-service")
    public void onPaymentCompleted(PaymentCompletedEvent event) {
        Notification notification = new Notification(
            event.getAggregateId(), null,
            NotificationType.PAYMENT_RECEIPT, NotificationChannel.EMAIL,
            "Payment Receipt",
            "Payment of " + event.getAmount() + " via " + event.getPaymentMethod() + " completed."
        );
        sendNotification.execute(notification);
    }
}
`)
}

// ─── SQL Migrations ────────────────────────────────────────────────────────

function generateSqlMigrations() {
  const sqlDir = `shared-lib/src/main/resources/db/migration`
  dir(sqlDir)

  file(`${sqlDir}/V001__create_users.sql`, `
CREATE TABLE users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(500),
    role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
`)

  file(`${sqlDir}/V002__create_orders.sql`, `
CREATE TABLE orders (
    id VARCHAR(36) PRIMARY KEY,
    customer_id VARCHAR(36) NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    total_amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    shipping_address TEXT NOT NULL,
    tracking_number VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_line_items (
    id VARCHAR(36) PRIMARY KEY,
    order_id VARCHAR(36) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id VARCHAR(36) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10,2) NOT NULL CHECK (unit_price > 0)
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_line_items_order ON order_line_items(order_id);
`)

  file(`${sqlDir}/V003__create_payments.sql`, `
CREATE TABLE payments (
    id VARCHAR(36) PRIMARY KEY,
    order_id VARCHAR(36) NOT NULL REFERENCES orders(id),
    customer_id VARCHAR(36) NOT NULL REFERENCES users(id),
    amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    payment_method VARCHAR(50),
    gateway_transaction_id VARCHAR(255),
    failure_reason TEXT,
    refunded_amount DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_status ON payments(status);
`)

  file(`${sqlDir}/V004__create_notifications.sql`, `
CREATE TABLE notifications (
    id VARCHAR(36) PRIMARY KEY,
    recipient_id VARCHAR(36) NOT NULL,
    recipient_email VARCHAR(255),
    type VARCHAR(30) NOT NULL,
    channel VARCHAR(10) NOT NULL,
    subject VARCHAR(500),
    body TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    failure_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id);
CREATE INDEX idx_notifications_status ON notifications(status);
`)
}

// ─── Config YAML ───────────────────────────────────────────────────────────

function generateConfigs() {
  const resDir = `order-service/src/main/resources`
  dir(resDir)

  file(`${resDir}/application.yml`, `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:postgresql://localhost:5432/orders
    username: order_user
    driver-class-name: org.postgresql.Driver
  jpa:
    hibernate:
      ddl-auto: validate
    show-sql: false
  kafka:
    bootstrap-servers: localhost:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer

server:
  port: 8081

order-service:
  max-items-per-order: 50
  payment-timeout-seconds: 30
  default-currency: USD

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,info
`)

  file(`${resDir}/application-dev.yml`, `
spring:
  datasource:
    url: jdbc:h2:mem:orders
    driver-class-name: org.h2.Driver
  jpa:
    show-sql: true
  kafka:
    bootstrap-servers: localhost:9092

server:
  port: 8081

logging:
  level:
    com.acme: DEBUG
`)

  file(`${resDir}/application-prod.yml`, `
spring:
  datasource:
    url: \${DATABASE_URL}
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
  jpa:
    show-sql: false
  kafka:
    bootstrap-servers: \${KAFKA_BROKERS}

server:
  port: 8080

management:
  endpoints:
    web:
      exposure:
        include: health
`)

  // Root pom.xml
  file(`pom.xml`, `
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.acme</groupId>
    <artifactId>acme-platform</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <packaging>pom</packaging>
    <name>ACME E-Commerce Platform</name>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version>
    </parent>

    <modules>
        <module>shared-lib</module>
        <module>order-service</module>
        <module>user-service</module>
        <module>payment-service</module>
        <module>notification-service</module>
    </modules>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2023.0.0</spring-cloud.version>
    </properties>
</project>
`)
}

// ─── Generate Everything ───────────────────────────────────────────────────

console.log('Generating sample monorepo...')
dir('')
generateSharedLib()
generateOrderService()
generateUserService()
generatePaymentService()
generateNotificationService()
generateSqlMigrations()
generateConfigs()

// Count files
let count = 0
function countFiles(d: string) {
  for (const f of readdirSync(join(ROOT, d))) {
    const p = join(d, f)
    if (statSync(join(ROOT, p)).isDirectory()) countFiles(p)
    else count++
  }
}
countFiles('')
console.log(`Generated ${count} files in ${ROOT}`)
