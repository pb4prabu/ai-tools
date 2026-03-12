import Parser from 'tree-sitter'
// @ts-ignore
import Java from 'tree-sitter-java'

const parser = new Parser()
parser.setLanguage(Java as any)

const code = `
package com.example.order;

import com.example.payment.PaymentService;
import com.example.inventory.InventoryService;
import com.example.event.OrderCreatedEvent;

@Service
public class OrderService {

    private final PaymentService paymentService;
    private final InventoryService inventoryService;
    private final OrderRepository orderRepository;

    public Order createOrder(OrderRequest request) {
        inventoryService.checkStock(request.getItems());
        Order order = new Order(request);
        orderRepository.save(order);
        paymentService.processPayment(order.getId(), request.getPaymentMethod());
        eventPublisher.publish(new OrderCreatedEvent(order));
        return order;
    }
}
`

const tree = parser.parse(code)

function findNodes(node: Parser.SyntaxNode, type: string, results: Parser.SyntaxNode[] = []): Parser.SyntaxNode[] {
  if (node.type === type) results.push(node)
  for (const child of node.namedChildren) findNodes(child, type, results)
  return results
}

console.log('=== IMPORT DECLARATIONS ===')
for (const node of findNodes(tree.rootNode, 'import_declaration')) {
  // Extract just the package path
  const path = node.namedChildren.find(c => c.type === 'scoped_identifier')
  console.log(`  ${path?.text}`)
}

console.log('\n=== FIELD DECLARATIONS (injected dependencies) ===')
for (const node of findNodes(tree.rootNode, 'field_declaration')) {
  const typeNode = node.descendantsOfType('type_identifier')[0]
  const nameNode = node.descendantsOfType('variable_declarator')[0]
  console.log(`  Type: ${typeNode?.text}  Name: ${nameNode?.text?.split('=')[0]?.trim()}`)
}

console.log('\n=== METHOD INVOCATIONS ===')
for (const node of findNodes(tree.rootNode, 'method_invocation')) {
  // Get the object and method name
  const children = node.namedChildren
  const methodName = node.childForFieldName('name')
  const object = node.childForFieldName('object')
  console.log(`  ${object?.text ?? '?'}.${methodName?.text ?? '?'}()`)
}

console.log('\n=== OBJECT CREATION (new ...) ===')
for (const node of findNodes(tree.rootNode, 'object_creation_expression')) {
  const typeNode = node.descendantsOfType('type_identifier')[0]
  console.log(`  new ${typeNode?.text}()`)
}
