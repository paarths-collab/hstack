// Hstack vault-key helper. JSON stdin/stdout only; no credential arguments.
import Foundation
import Security
import LocalAuthentication

func reply(_ value: [String: Any]) -> Never {
    if let bytes = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(bytes)
    }
    exit(value["error"] == nil ? 0 : 1)
}
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count <= 4096,
      let input = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      let account = input["account"], account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let action = input["action"], ["read", "create", "delete"].contains(action)
else { reply(["error": "invalid_request"]) }
let authentication = LAContext()
authentication.interactionNotAllowed = true
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "org.hstack.credential-vault.v1",
    kSecAttrAccount as String: account,
    kSecUseAuthenticationContext as String: authentication]
if action == "delete" {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { reply(["error": "keychain_unavailable"]) }
    reply(["deleted": true])
}
func readKey() -> (OSStatus, Data?) {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &found)
    return (status, found as? Data)
}
var (status, key) = readKey()
if status == errSecItemNotFound && action == "create" {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { reply(["error": "keychain_unavailable"]) }
    var item = query
    item[kSecValueData as String] = Data(bytes)
    item[kSecAttrLabel as String] = "Hstack credential vault"
    item[kSecAttrSynchronizable as String] = false
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess || added == errSecDuplicateItem else { reply(["error": "keychain_unavailable"]) }
    (status, key) = readKey()
}
guard status == errSecSuccess, let key = key, key.count == 32 else {
    reply(["error": status == errSecItemNotFound ? "key_missing" : "keychain_unavailable"])
}
reply(["key": key.base64EncodedString()])
