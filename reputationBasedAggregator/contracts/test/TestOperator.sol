// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title TestOperator
 * @notice Gas-faithful stand-in for Chainlink's Operator (operatorforwarder/Operator.sol, which pins
 *         solc 0.8.19). It reproduces the parts that cost gas on the request and fulfil paths:
 *         onTokenTransfer -> operatorRequest (request id, commitment SSTORE, OracleRequest event with
 *         the full CBOR payload) and fulfillOracleRequest2 (authorized-sender check, commitment check
 *         and delete, OracleResponse event, 400k-gas floor, callback without bubbling). `strict` makes
 *         a failed callback revert, which the tests use to surface errors; `bomb` burns all gas it is
 *         given on every request. `gate` reproduces ArbiterOperator's keeper allow-list: with a keeper
 *         set, requests and fulfilments need keeper.isContractApproved(requester), as on mainnet.
 */
contract TestOperator {
    struct Commitment {
        bytes31 paramsHash;
        uint8 dataVersion;
    }

    address private _owner;
    bool public shortOwner;   // owner() returns 1 byte (malformed): must skip the slot, not revert the draw
    bool public bigOwner;     // owner() returns the owner followed by 64 KB (a return-data bomb)
    address public immutable link;
    bool public strict = true;
    bool public bomb;   // burn all gas on every request (an arbiter griefing the draw)
    address public gate;   // ArbiterOperator's rkList (one keeper): 0 = gate disabled
    mapping(address => bool) private authorized;
    mapping(bytes32 => Commitment) private commitments;

    event OracleRequest(
        bytes32 indexed specId,
        address requester,
        bytes32 requestId,
        uint256 payment,
        address callbackAddr,
        bytes4 callbackFunctionId,
        uint256 cancelExpiration,
        uint256 dataVersion,
        bytes data
    );
    event OracleResponse(bytes32 indexed requestId);

    constructor(address _link, address owner_, address _node) {
        link = _link;
        _owner = owner_;
        authorized[_node] = true;
    }

    function owner() external view returns (address) {
        if (bigOwner) {
            address o = _owner;
            assembly {
                mstore(0, o)
                return(0, 65536)
            }
        }
        if (shortOwner) {
            assembly {
                mstore(0, 1)
                return(31, 1)
            }
        }
        return _owner;
    }

    function setShortOwner(bool b) external {
        require(msg.sender == _owner, "only owner");
        shortOwner = b;
    }

    function setBigOwner(bool b) external {
        bigOwner = b;
    }

    function setAuthorizedSenders(address[] calldata senders) external {
        require(msg.sender == _owner, "only owner");
        for (uint256 i = 0; i < senders.length; i++) authorized[senders[i]] = true;
    }

    function isAuthorizedSender(address s) external view returns (bool) {
        return authorized[s];
    }

    function setStrict(bool s) external {
        strict = s;
    }

    function setBomb(bool b) external {
        bomb = b;
    }

    function setGate(address keeper) external {
        gate = keeper;
    }

    /// @dev ArbiterOperator._approved: the requester must be approved by the keeper
    function _approved(address requester) internal view returns (bool) {
        if (gate == address(0)) return true;
        (bool ok, bytes memory out) = gate.staticcall(abi.encodeWithSignature("isContractApproved(address)", requester));
        return ok && out.length >= 32 && abi.decode(out, (bool));
    }

    function onTokenTransfer(address sender, uint256 amount, bytes calldata data) external {
        require(msg.sender == link, "Must use LINK token");
        require(_approved(sender), "Operator: requester not approved");
        if (bomb) {
            uint256 x;
            while (true) x++;
        }
        (, , bytes32 specId, bytes4 cbFn, uint256 nonce, uint256 dataVersion, bytes memory payload) =
            abi.decode(data[4:], (address, uint256, bytes32, bytes4, uint256, uint256, bytes));
        bytes32 requestId = keccak256(abi.encodePacked(sender, nonce));
        require(commitments[requestId].paramsHash == 0, "Must use a unique ID");
        uint256 expiration = block.timestamp + 5 minutes;
        bytes31 ph = bytes31(keccak256(abi.encodePacked(amount, sender, cbFn, expiration)));
        commitments[requestId] = Commitment(ph, uint8(dataVersion));
        emit OracleRequest(specId, sender, requestId, amount, sender, cbFn, expiration, dataVersion, payload);
    }

    function fulfillOracleRequest2(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4 callbackFunctionId,
        uint256 expiration,
        bytes calldata data
    ) external returns (bool success) {
        require(authorized[msg.sender], "Not authorized sender");
        require(_approved(callbackAddress), "Operator: requester not approved");
        require(commitments[requestId].paramsHash != 0, "Must have a valid requestId");
        bytes31 ph = bytes31(keccak256(abi.encodePacked(payment, callbackAddress, callbackFunctionId, expiration)));
        require(commitments[requestId].paramsHash == ph, "Params do not match request ID");
        bytes32 first;
        assembly {
            first := calldataload(data.offset)
        }
        require(first == requestId, "First word must be requestId");
        delete commitments[requestId];
        emit OracleResponse(requestId);
        require(gasleft() >= 400_000, "Must provide consumer enough gas");
        bytes memory ret;
        (success, ret) = callbackAddress.call(abi.encodePacked(callbackFunctionId, data));
        if (!success && strict) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
