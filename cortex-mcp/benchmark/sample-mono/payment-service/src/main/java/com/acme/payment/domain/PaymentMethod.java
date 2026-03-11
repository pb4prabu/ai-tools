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
