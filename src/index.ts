import { POOLS, BLACKLIST } from "./utils";
import { IMP_ABI, WFTM_ABI, WFTM_ADDRESS } from "./abi";
import Web3 from "web3";
import { AbiItem, fromWei } from 'web3-utils'

const Express = require('express');
const app = Express();
const address = process.env.BOT_ADDRESS!
let blacklist = new Map<string, boolean>(Object.entries(BLACKLIST))

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`App is running on port ${ PORT }`);
    let web3 = new Web3('https://rpc.ftm.tools/');

    app.get('/', async (_: any, res: any) => {
      const gas = await web3.eth.getGasPrice()

      res.send('GAS ' + fromWei(gas, 'gwei'));
    });
    
    var http = require("http");
    setInterval(function() {
      http.get("http://reaperharvest.herokuapp.com");
    }, 300000);

    const account = web3.eth.accounts.privateKeyToAccount(String(process.env.BOT_P_KEY))
    web3.eth.accounts.wallet.add(account);
    web3.eth.defaultAccount = account.address;
  
    web3.eth.net.isListening().then(() => {
      console.log('connected');
      runLoop(web3)
    }).catch(() => {
      console.log('Lost connection');
    })
});

async function runLoop(web3: Web3) {
  try {
    await requestPools(web3)
  } catch (error) {
    console.log(error);
    await sleep(30)
    runLoop(web3)
  }
}

async function requestPools(web3: Web3) {
  const realGasPrice = await web3.eth.getGasPrice()
  const maxGasPrice = 300

  // TMP, for now we harvest only when gas is low, sometimes fantom have spikes in gas
  // and the logic to make profitable harvest is tricky as the estimated gas is not fast enough
  // will need to figure out some logic to use enough gas while still being profitable and not miss out most harvests
  function canExecute(gasPrice: string): Boolean {
    const gweiGasPrice = fromWei(gasPrice, 'gwei')

    if (Number(gweiGasPrice) > maxGasPrice) {
      console.log('Gas is high (' + gweiGasPrice + ') skipping');
      return false
    }

    return true
  }

  const gasPriceFactor = 80
  var gasPrice = String(Number(realGasPrice) * gasPriceFactor / 100) // when Fantom is not congested 90% of the reported gas price is usually enough to have a fast enough and profitable tx
  console.log('real gas price ' + fromWei(realGasPrice, 'gwei'))
  console.log('gas price ' + fromWei(gasPrice, 'gwei'))

  await unwrapRewards(web3, gasPrice)

  var count = 0;
  for (var pool of POOLS.data) {
    const addr = pool.cryptContent.strategy.address
    if (blacklist.get(addr) == true) {
      continue
    }
    count++;

    if (count % 20 == 0) { // refresh gas every now and then
      const currentGasPrice = await web3.eth.getGasPrice() 
      gasPrice = String(Number(currentGasPrice) * gasPriceFactor / 100)
      console.log('gas price ' + fromWei(gasPrice, 'gwei'))
    }

    if (!canExecute(gasPrice)) {
      await sleep(20)
      return
    }

    console.log(count + ' Checking ' + pool.cryptContent.name)
    const result = await request(web3, pool.cryptContent.strategy.address, gasPrice)
    blacklist.set(addr, result == false)
    console.log('\n')
  }

  console.log('Repeat\n')
  await sleep(1)
  await requestPools(web3)
}

async function sleep(s: number) {
  console.log("sleep " + s)
  return new Promise(resolve => setTimeout(resolve, s * 1000));
}

async function request(web3: Web3, contractAddr: string, gasPrice: string): Promise<boolean> {
  const options = { from: address, gasPrice: '10' }
  const contract = new web3.eth.Contract(IMP_ABI as AbiItem[], contractAddr, options)
  const rewardObj = await contract.methods.estimateHarvest().call()
  const reward = rewardObj["callFeeToUser"]

  if (Number(fromWei(reward, 'ether')) > 500) {
    // some pools have wrong reward, mostly creditum ones
    return true
  }

  const estimatedGasCount = BigInt(await contract.methods.harvest().estimateGas())
  const gasCount = (estimatedGasCount / BigInt(10)) + estimatedGasCount // add 10% more as the estimation is not really precise
  const safeGasCount = (estimatedGasCount / BigInt(25)) + estimatedGasCount // use 25% more to execute, eventually not completely profitable but more profitable than a failing tx
  const estimatedGas = BigInt(gasCount) * BigInt(gasPrice)

  if (Number(estimatedGas) > 2000000000000000000) {
    console.log('Avoid big cost ' + fromWei(String(estimatedGas), 'ether'))
    return true
  }

  const profit = BigInt(reward) - BigInt(estimatedGas)
  const minProfit = 100000000000000000;
  console.log("\n\nProfit " + fromWei(String(profit), 'ether') + "\n\n")
  console.log("\n\Reward " + fromWei(String(reward), 'ether') + "\n\n")

  if (profit >= minProfit) {
    console.log('gas count ' + gasCount)
    console.log('cost ' + fromWei(String(estimatedGas), 'ether'))

    try {
      await sleep(5)
      await contract.methods.harvest().send({ from: address, gas: String(safeGasCount), gasPrice: String(gasPrice) })
    } catch (error) {
      console.log(error)
      await sleep(15)
    }
  }

  return true
}

/// Rewards from harvests are in WFTM, when the FTM balance is low we unwrap the rewards to pay for gas.
async function unwrapRewards(web3: Web3, gasPrice: String) {
  try {
    const balance = await web3.eth.getBalance(address);

    if (Number(fromWei(balance, 'ether')) > 1) {
      console.log('no need to withdraw')
      return
    }

    console.log('Unwrapping')

    const options = { from: address, gasPrice: '10' }
    const contract = new web3.eth.Contract(WFTM_ABI as AbiItem[], WFTM_ADDRESS, options)
    const wrappedBalance = await contract.methods.balanceOf(address).call()
    if (Number(fromWei(wrappedBalance, 'ether')) >= 1) {
      console.log('Wrapped balance too low')
      await sleep(60)
      return
    }

    await contract.methods.withdraw(wrappedBalance).send({ from: address, gas: "155000", gasPrice: gasPrice })
  } catch (error) {
    console.log(error)
    await sleep(5)
    await unwrapRewards(web3, gasPrice)
  }
}