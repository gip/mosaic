import Foundation

/// Integer-string arithmetic for chain amounts. Amounts stay decimal strings
/// end to end (the repo-wide rule from @mosaic/chain-core); this converts the
/// two wire formats that need it — EVM hex quantities and fixed-point
/// integers like XRP drops — without ever passing through Double.
public enum DecimalString {
  /// "0x0de0b6b3a7640000" -> "1000000000000000000". Pure digit-array math so
  /// values beyond UInt64 (ETH wei routinely is) stay exact.
  public static func fromHexQuantity(_ hex: String) -> String? {
    var digits = hex.lowercased()
    if digits.hasPrefix("0x") { digits.removeFirst(2) }
    if digits.isEmpty { return nil }
    var result: [UInt8] = [0]
    for character in digits {
      guard let nibble = character.hexDigitValue else { return nil }
      var carry = nibble
      for i in result.indices {
        let value = Int(result[i]) * 16 + carry
        result[i] = UInt8(value % 10)
        carry = value / 10
      }
      while carry > 0 {
        result.append(UInt8(carry % 10))
        carry /= 10
      }
    }
    while result.count > 1, result.last == 0 { result.removeLast() }
    return String(result.reversed().map { Character(String($0)) })
  }

  /// Scale an integer string down by `decimals` places: ("1234567", 6) -> "1.234567".
  /// Trailing fractional zeros are trimmed.
  public static func scaleDown(_ integer: String, decimals: Int) -> String? {
    guard decimals >= 0, !integer.isEmpty, integer.allSatisfy(\.isNumber) else { return nil }
    if decimals == 0 { return normalizeInteger(integer) }
    let padded = String(repeating: "0", count: max(0, decimals + 1 - integer.count)) + integer
    let splitIndex = padded.index(padded.endIndex, offsetBy: -decimals)
    let whole = normalizeInteger(String(padded[..<splitIndex]))
    var fraction = String(padded[splitIndex...])
    while fraction.hasSuffix("0") { fraction.removeLast() }
    return fraction.isEmpty ? whole : "\(whole).\(fraction)"
  }

  private static func normalizeInteger(_ value: String) -> String {
    let trimmed = value.drop { $0 == "0" }
    return trimmed.isEmpty ? "0" : String(trimmed)
  }
}
