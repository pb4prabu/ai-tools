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
