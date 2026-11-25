// Round-2 review (compromise direction): what the keeper's owner key alone can do, measured.
// Not a bug test: it records today's owner powers, so a timelock or role split can be checked against it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");

describe("owner key compromise: keeper", function () {
  it("burns every stake and bans every arbiter in 3 transactions, then a fresh attacker arbiter is every juror", async () => {
    const core = await H.deployCore({ withAggregator: false });
    const { keeper, token, deployer: owner } = core;
    const arbs = await H.registerArbiters(core, 12);
    const keys = arbs.map((a) => a.key);
    const staked = await token.balanceOf(await keeper.getAddress());
    expect(staked).to.equal(12n * H.STAKE);

    const attacker = (await ethers.getSigners())[5];
    let txs = 0;
    await keeper.connect(owner).setPenalties(1, 0, true); txs++;          // the first block is a ban, a ban burns the stake
    await keeper.connect(owner).setRoles(attacker.address, 4); txs++;     // ROLE_SCORE to an EOA
    await keeper.connect(attacker).applyOutcomes(keys, keys.map(() => H.code(H.T.MISS_FAILED)), (await time.latest()) + 1); txs++;
    expect(txs).to.equal(3);

    expect(await token.balanceOf(await keeper.getAddress())).to.equal(0n);
    for (const k of keys) {
      const a = await keeper.getArbiter(k);
      expect(a.stake).to.equal(0n);
    }

    // The pool is now whatever the attacker registers: one arbiter fills a whole jury (repeats allowed).
    const [evil] = await H.registerArbiters(core, 1, { nodes: [attacker] });
    await keeper.connect(owner).setRoles(attacker.address, 2 | 4);       // ROLE_SELECT, to call selection directly here
    await ethers.provider.send("evm_mine", []);
    const b = await ethers.provider.getBlock((await ethers.provider.getBlockNumber()) - 1);
    const sel = await keeper.connect(attacker).selectArbiters.staticCall(
      { count: 5, alpha: 500, maxFee: H.MAX_FEE, minFee: 0, estimatedBaseCost: H.BASE_COST, maxFeeBasedScalingFactor: 5, requestedClass: 1 },
      ethers.hexlify(ethers.randomBytes(32)), b.number, b.timestamp);
    expect(sel.map((s) => s.key)).to.deep.equal(Array(5).fill(evil.key));
  });
});
