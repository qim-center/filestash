import React from "react";

export class ChmodComponent extends React.Component {

    checkboxLine(group, checks, index){
        return <tr><td>{group}</td> {this.checkboxWithLabel(group, "Read", checks[0], index)} {this.checkboxWithLabel(group, "Write", checks[1], index+1)} {this.checkboxWithLabel(group, "Execute", checks[2], index+2)}</tr>;
    }

    checkboxWithLabel(group, type, checked, index){
        let disabled = !(this.props.fileInfo.uid === this.props.userInfo.uid);
        return <td style = {{whiteSpace: "nowrap"}}><input type="checkbox" id={group + type} onChange={this.props.onChange(index)} defaultChecked = {checked} disabled = {disabled}/><label for = {group + type}>{type}</label></td>;

    }


    render() {
        let perms = this.props.permissions;
        return (
        <div>
            <h4>Change of permissions</h4>
            <table>
                { this.checkboxLine("User", perms.slice(0,3), 0) }
                { this.checkboxLine("Group", perms.slice(3,6), 3) }
                { this.checkboxLine("All", perms.slice(6), 6) }
            </table>
        </div>
        );
    };
}