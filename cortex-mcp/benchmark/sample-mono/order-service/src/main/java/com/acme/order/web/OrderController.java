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
