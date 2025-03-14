'use strict'

const chalk = require('chalk')
const REST_API_ID_KEY = 'ApiGatewayRestApiWaf';
const DEFAULT_WAF_VERSION = "WAFRegional"
const DEFAULT_WAF_SCOPE = "REGIONAL"

const get = (obj, path, defaultValue) => {
  return path.split('.').filter(Boolean).every(step => !(step && !(obj = obj[step]))) ? obj : defaultValue
}

class AssociateWafPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.provider = this.serverless.providers.aws

    this.config = get(this.serverless.service, 'custom.associateWaf', {})

    this.wafVersion = `WAF${this.config.version || "Regional"}` //config.version can be one of [V2, Regional]
    this.wafScope = DEFAULT_WAF_SCOPE //WAFV2 requires a scope setting
    this.verifyValidWafConfig()
    this.hooks = {}

    this.hooks['after:deploy:deploy'] = this.updateWafAssociation.bind(this)
    this.hooks['before:package:finalize'] = this.updateCloudFormationTemplate.bind(this)
  }

  verifyValidWafConfig() {
    const validVersions = [DEFAULT_WAF_VERSION, "WAFV2"] //allowed WAF versions
    if (!validVersions.includes(this.wafVersion)) {
      this.wafVersion = DEFAULT_WAF_VERSION
      this.serverless.cli.log(`\n-------- Invalid WAF Version Configuration --------\nVersion Defaulted to ${this.wafVersion}`)
    }
  }

  defaultStackName() {
    return `${this.serverless.service.getServiceName()}-${this.provider.getStage()}`
  }

  getApiGatewayStageArn(restApiId) {
    return `arn:aws:apigateway:${this.provider.getRegion()}::/restapis/${restApiId}/stages/${this.provider.getStage()}`
  }

  updateCloudFormationTemplate() {
    this.outputRestApiId()
  }

  outputRestApiId() {
    const autoGeneratedRestApiId = { Ref: 'ApiGatewayRestApi' };

    this.serverless.service.provider.compiledCloudFormationTemplate.Outputs[REST_API_ID_KEY] = {
      Description: 'Rest API Id',
      Value: autoGeneratedRestApiId,
    };
  };

  async updateWafAssociation() {
    if ((this.config) && (this.config.name) && (this.config.name.trim().length != 0)){
      await this.associateWaf();
    } else {
      await this.disassociateWaf();
    }
  }

  async findWebAclByName(name) {
    let params = { Limit: 100 }
    if (this.wafVersion !== DEFAULT_WAF_VERSION) { //WAFV2 requires Scope variable
      params.Scope = this.wafScope
    }

    let response
    do {
      response = await this.provider.request(this.wafVersion, 'listWebACLs', params)
      if (response.WebACLs) {
        for (let webAcl of response.WebACLs) {
          if (name === webAcl.Name) {
            return this.wafVersion === DEFAULT_WAF_VERSION ? webAcl.WebACLId : webAcl.ARN //WAFV2 uses WebACLArn instead of WebACLId
          }
        }
      }
      params.NextMarker = response.NextMarker
    } while (params.NextMarker)

    return null; // Return null if WebACL is not found
  }

  async findStackResourceByLogicalId(stackName, logicalId) {
    const response = await this.provider.request('CloudFormation', 'listStackResources', { StackName: stackName })
    if (response.StackResourceSummaries) {
      for (let resourceSummary of response.StackResourceSummaries) {
        if (logicalId === resourceSummary.LogicalResourceId) {
          return resourceSummary
        }
      }
    }
  }

  async findStackOutputByLogicalId(stackName, logicalId) {
    const response = await this.provider.request('CloudFormation', 'describeStacks', { StackName: stackName })
    if(response.Stacks) {
      if (response.Stacks[0].Outputs) {
        for (let resourceSummary of response.Stacks[0].Outputs) {
          if (logicalId === resourceSummary.OutputKey) {
            return resourceSummary
          }
        }
      }
    }
  }

  async getRestApiId() {
    const apiGateway = this.serverless.service.provider.apiGateway
    if (apiGateway && apiGateway.restApiId) {
      return apiGateway.restApiId
    }

    const stackName = this.serverless.service.provider.stackName || this.defaultStackName();

    const stackResource = await this.findStackResourceByLogicalId(stackName, 'ApiGatewayRestApi')
    if (!stackResource) {
      this.serverless.cli.log(`RestApiId not found (split stacks plugin used?), using stack outputs for RestApiId.`);
      const stackOutput = await this.findStackOutputByLogicalId(stackName, REST_API_ID_KEY)
      if (stackOutput && stackOutput.OutputValue) {
        return stackOutput.OutputValue
      }
    }

    if (stackResource && stackResource.PhysicalResourceId) {
      return stackResource.PhysicalResourceId
    }
  }

  async associateWaf() {
    try {
      const restApiId = await this.getRestApiId()
      if (!restApiId) {
        this.serverless.cli.log('Unable to determine REST API ID')
        return
      }

      const webAclId = await this.findWebAclByName(this.config.name)
      if (!webAclId) {
        this.serverless.cli.log(`Unable to find WAF named '${this.config.name}'`)
        return
      }

      const params = this.wafVersion === DEFAULT_WAF_VERSION ?
        {
          ResourceArn: this.getApiGatewayStageArn(restApiId), //used for WAFRegional
          WebACLId: webAclId
        }
        :
        {
          ResourceArn: this.getApiGatewayStageArn(restApiId), //used for WAFV2
          WebACLArn: webAclId
        }

      this.serverless.cli.log('Associating WAF...')
      await this.provider.request(this.wafVersion, 'associateWebACL', params)
    } catch (e) {
      console.error(chalk.red(`\n-------- Associate WAF Error --------\n${e.message}`))
    }
  }

  async disassociateWaf() {
    try {
      const restApiId = await this.getRestApiId()
      if (!restApiId) {
        this.serverless.cli.log('Unable to determine REST API ID')
        return
      }

      const params = {
        ResourceArn: this.getApiGatewayStageArn(restApiId)
      }

      const webACLForResource = await this.provider.request(this.wafVersion, 'getWebACLForResource', params)
      if (webACLForResource.WebACLSummary || webACLForResource.WebACL) { //WAFV2 uses WebACL
        this.serverless.cli.log('Disassociating WAF...')
        await this.provider.request(this.wafVersion, 'disassociateWebACL', params)
      }

    } catch (e) {
      console.error(chalk.red(`\n-------- Disassociate WAF Error --------\n${e.message}`))
    }
  }
}

module.exports = AssociateWafPlugin
