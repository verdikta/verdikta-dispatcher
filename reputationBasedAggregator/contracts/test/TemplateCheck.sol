// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Chainlink} from "@chainlink/contracts/src/v0.8/operatorforwarder/Chainlink.sol";
import {OperatorInterface} from "@chainlink/contracts/src/v0.8/operatorforwarder/interfaces/OperatorInterface.sol";
import {LinkTokenInterface} from "@chainlink/contracts/src/v0.8/shared/interfaces/LinkTokenInterface.sol";

/// @dev Test only: the transferAndCall calldata ChainlinkClient._sendOperatorRequestTo builds for a request
///      with the given nonce (ChainlinkClient takes the nonce from its counter; everything else is identical).
contract TemplateCheck {
    using Chainlink for Chainlink.Request;

    function expected(string memory payload, string memory aggIdHex, address operator, bytes32 jobId, uint256 nonce, bytes4 cb)
        external
        view
        returns (bytes memory)
    {
        Chainlink.Request memory req;
        req._initialize(jobId, address(this), cb);
        req._add("cid", payload);
        req._add("aggId", aggIdHex);
        bytes memory enc = abi.encodeWithSelector(
            OperatorInterface.operatorRequest.selector, address(0), uint256(0), req.id, req.callbackFunctionId, nonce,
            uint256(2), req.buf.buf
        );
        return abi.encodeWithSelector(LinkTokenInterface.transferAndCall.selector, operator, uint256(0), enc);
    }
}

interface IERC677Recv {
    function onTokenTransfer(address sender, uint256 value, bytes calldata data) external;
}

/// @dev Test only: MockLinkToken that logs the exact calldata of each transferAndCall it receives
contract RecordingLink {
    event Call(bytes data);
    mapping(address => uint256) public balanceOf;

    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool) {
        require(to != address(0) && to != address(this), "bad recipient");   // LinkToken's validRecipient
        emit Call(msg.data);
        if (to.code.length > 0) IERC677Recv(to).onTokenTransfer(msg.sender, value, data);
        return true;
    }
}

interface IFulfill {
    function fulfill(bytes32 requestId, uint256[] memory response, string memory cid) external;
    function drawJury(bytes32 aggId) external;
    function withdrawEth() external;
}

/// @dev Test only: an operator that, inside onTokenTransfer, tries to answer its own request (and other
///      aggregator entry points) and records what happened. Never reverts the dispatch itself.
contract ReenterOperator {
    address public immutable link;
    address private immutable _owner;
    uint256 public attempts;
    uint256 public successes;
    bytes32 public lastId;

    constructor(address link_, address owner_) {
        link = link_;
        _owner = owner_;
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function onTokenTransfer(address sender, uint256, bytes calldata data) external {
        (, , , , uint256 nonce, , ) = abi.decode(data[4:], (address, uint256, bytes32, bytes4, uint256, uint256, bytes));
        bytes32 id = keccak256(abi.encodePacked(sender, nonce));
        lastId = id;
        uint256[] memory r = new uint256[](1);
        r[0] = 1;
        attempts++;
        try IFulfill(sender).fulfill(id, r, "") { successes++; } catch {}
        attempts++;
        try IFulfill(sender).withdrawEth() { successes++; } catch {}
    }

    function answer(address agg, bytes32 id, uint256[] memory r, string memory cid) external {
        IFulfill(agg).fulfill(id, r, cid);
    }
}
